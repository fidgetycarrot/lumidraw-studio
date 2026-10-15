# Lumi Studio 1.9.8 (staging): loads again on the newer Lumiverse

**Error:** `Extension "lumidraw_studio" uses blocked backend capabilities: direct fetch API usage`

Lumiverse now blocks extension backends from using the fetch API directly.
Every web request has to go through Lumiverse's own proxy, `spindle.cors`
(permission: CORS proxy, which Lumi Studio already asks for). The proxy still
reaches servers on your own computer and network.

Five places changed, all now through one helper (`hostRequest`):
Draw Things, SwarmUI's API, downloading the finished SwarmUI image, the Bridge,
and the cloud relay. Jev already used the proxy. SwarmUI's live-progress
WebSocket is unchanged, since only the fetch API is blocked.

Checked with a stand-in proxy that behaves as Lumiverse documents (text bodies,
images returned as base64) against fake local servers: config, txt2img with
an image back, SwarmUI session and image download, Bridge, relay, an HTTP
error, a timeout, and an offline server all behave as before. The story scan
tests still pass. Not yet run inside the new Lumiverse.

If Lumi Studio still won't load, check that the CORS proxy permission is
allowed for it in Lumiverse's Extensions page.
