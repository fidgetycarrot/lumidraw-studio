# Lumi Studio 1.8.3: loads again on the newer Lumiverse

Same network fix as staging 1.9.8, and nothing else from staging.

**Error:** `Extension "lumidraw_studio" uses blocked backend capabilities: direct fetch API usage`

Lumiverse now blocks extension backends from using the fetch API directly.
Draw Things, SwarmUI (API and image download), the Bridge and the cloud relay
now go through Lumiverse's own proxy, `spindle.cors` (the CORS proxy permission
Lumi Studio already asks for). It still reaches servers on your own computer
and network. Jev already used the proxy.

Checked against fake local servers through a stand-in proxy: every request
goes through the proxy, and successes, HTTP errors, timeouts and an offline
server all behave as before.
