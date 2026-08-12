#!/usr/bin/env node
//
// LumiDraw cloud relay — Draw Things Cloud Compute for LumiDraw Studio
// ---------------------------------------------------------------------------
//
// WHY THIS EXISTS
//
// LumiDraw talks to Draw Things over its local HTTP API. That path cannot reach
// Cloud Compute; Draw Things answers:
//
//   Cloud Compute can only access models from Official or Community channels.
//   Your local models cannot be used for this generation.
//
// and it answers that even for a community model set on both sides, while the
// identical settings run on cloud from inside the app. It is the request path,
// not the configuration.
//
// The documented cloud path is gRPC, shipped as a Swift package
// (MediaGenerationKit) with an example client, media-generation-kit-cli. A
// Spindle extension running inside Lumiverse's Node process can neither speak
// gRPC nor run a Swift binary — so this relay does it, and LumiDraw talks to
// the relay in plain JSON over HTTP, the way it already talks to the Bridge.
//
// THE API KEY NEVER LEAVES THIS PROCESS.
//
// It is read from the environment here. It is never sent to LumiDraw, never
// written to settings storage, never rendered in the frontend, and so cannot
// appear in a settings dump. `/health` reports whether a key is present, never
// what it is.
//
// RUNNING IT
//
//   export DRAWTHINGS_API_KEY="dt-..."
//   node lumidraw-cloud-relay.mjs
//
// Then in LumiDraw: Settings → Cloud → enable, port 7864.
//
// Environment:
//   DRAWTHINGS_API_KEY   required unless you have run `auth login` in the CLI
//   LUMIDRAW_CLOUD_PORT  default 7864
//   LUMIDRAW_CLOUD_HOST  default 127.0.0.1 (loopback only — do not expose this)
//   LUMIDRAW_CLOUD_CLI   path to media-generation-kit-cli, if not on PATH

import http from 'node:http'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const PORT = Number(process.env.LUMIDRAW_CLOUD_PORT) || 7864
const HOST = process.env.LUMIDRAW_CLOUD_HOST || '127.0.0.1'
const CLI = process.env.LUMIDRAW_CLOUD_CLI || 'media-generation-kit-cli'
const API_KEY = process.env.DRAWTHINGS_API_KEY || ''
const GENERATE_TIMEOUT_MS = 280000

const log = (...args) => console.log('[relay]', ...args)

// --- the CLI ---------------------------------------------------------------

function run(args, timeoutMs = 30000, redact = []) {
  return new Promise((resolve) => {
    const shown = args.map((a) => (redact.includes(a) ? '«redacted»' : a))
    log('$', CLI, shown.join(' '))
    let child
    try {
      child = spawn(CLI, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err && err.message || err) })
      return
    }
    let stdout = '', stderr = '', done = false
    const finish = (result) => { if (!done) { done = true; resolve(result) } }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ code: -1, stdout, stderr: stderr + `\ntimed out after ${Math.round(timeoutMs / 1000)}s` })
    }, timeoutMs)
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (err) => {
      clearTimeout(timer)
      finish({ code: -1, stdout, stderr: String(err && err.message || err) })
    })
    child.on('close', (code) => { clearTimeout(timer); finish({ code, stdout, stderr }) })
  })
}

async function cliPresent() {
  const res = await run(['--help'], 15000)
  // A missing binary surfaces as ENOENT on the spawn error, not as an exit code.
  if (/ENOENT|not found/i.test(res.stderr) && res.code === -1) return ''
  return (res.stdout || res.stderr).split('\n')[0].trim() || 'present'
}

async function authState() {
  const args = ['auth', 'state']
  if (API_KEY) args.push('--api-key', API_KEY)
  const res = await run(args, 20000, [API_KEY])
  return { ok: res.code === 0, detail: (res.stdout + res.stderr).trim().slice(0, 500) }
}

// --- generation ------------------------------------------------------------

function flagsFor(body) {
  const out = []
  const push = (flag, value) => {
    if (value === undefined || value === null || value === '') return
    out.push(flag, String(value))
  }
  push('--prompt', body.prompt)
  push('--negative-prompt', body.negative_prompt)
  push('--model', body.model)
  push('--width', body.width)
  push('--height', body.height)
  push('--num-inference-steps', body.steps)
  push('--guidance-scale', body.guidance_scale)
  // -1 is LumiDraw's "random"; the CLI wants the flag omitted for that.
  if (body.seed !== undefined && Number(body.seed) >= 0) push('--seed', body.seed)
  push('--sampler', body.sampler)
  push('--shift', body.shift)
  return out
}

async function generate(body) {
  const file = path.join(os.tmpdir(), `lumidraw-cloud-${crypto.randomUUID()}.png`)
  const args = ['generate', '--cloud-compute']
  if (API_KEY) args.push('--api-key', API_KEY)
  args.push(...flagsFor(body), '--output', file)

  const res = await run(args, GENERATE_TIMEOUT_MS, [API_KEY])
  const output = (res.stdout + '\n' + res.stderr).trim()
  try {
    if (res.code !== 0) return { error: output || `the CLI exited ${res.code}` }
    const bytes = await fs.readFile(file)
    if (!bytes.length) return { error: 'the CLI wrote an empty file' }
    return { images: [bytes.toString('base64')] }
  } catch (err) {
    return { error: `no image was produced. ${output || String(err && err.message || err)}`.slice(0, 800) }
  } finally {
    fs.unlink(file).catch(() => {})
  }
}

// --- server ----------------------------------------------------------------

const send = (res, status, payload) => {
  const text = JSON.stringify(payload)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}

function readBody(req, limitBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limitBytes) { reject(new Error('request body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) }
      catch (err) { reject(new Error('body was not JSON')) }
    })
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)

  if (url.pathname === '/health') {
    const cli = await cliPresent()
    const auth = cli ? await authState() : { ok: false, detail: '' }
    send(res, 200, {
      ok: true,
      cli,                                  // '' when the binary is missing
      keyPresent: !!API_KEY,                // never the key itself
      authenticated: auth.ok,
      detail: auth.detail,
    })
    return
  }

  if (url.pathname === '/generate' && req.method === 'POST') {
    let body
    try { body = await readBody(req) }
    catch (err) { send(res, 400, { error: String(err && err.message || err) }); return }
    if (!body.prompt) { send(res, 400, { error: 'no prompt' }); return }
    if (!body.model) { send(res, 400, { error: 'no model — Cloud Compute needs a catalog id, not a local filename' }); return }
    const result = await generate(body)
    if (result.error) { send(res, 502, result); return }
    log(`generated ${Math.round(result.images[0].length * 0.75 / 1024)}KB`)
    send(res, 200, result)
    return
  }

  send(res, 404, { error: 'not found' })
})

server.listen(PORT, HOST, async () => {
  log(`listening on http://${HOST}:${PORT}`)
  log(`API key: ${API_KEY ? 'from DRAWTHINGS_API_KEY' : 'not set — relying on `' + CLI + ' auth login`'}`)
  const cli = await cliPresent()
  if (!cli) {
    log(`WARNING: "${CLI}" was not found on PATH.`)
    log('Build it from https://github.com/drawthingsai/media-generation-kit, or set LUMIDRAW_CLOUD_CLI to its path.')
  } else {
    log(`CLI: ${cli}`)
  }
})
