# Yuko.ai

**A privacy-first, browser-based AI workspace for chat, image generation, and reference-image enhancement.** Yuko has no app-owned backend, database, accounts, analytics, or telemetry. The static app can be hosted with GitHub Pages; the browser sends requests directly to the AI provider you select.

## Features

- Responsive dark-mode workspace with chat history saved in browser `localStorage`.
- Direct Ollama chat through `http://localhost:11434` (including compatible image-capable local models).
- OpenRouter chat with a user-supplied key and dynamically loaded model list.
- Image studio with style tags, aspect ratio/resolution, multiple outputs, and selectable image models.
- Reference uploads for supported image enhancement, restyling, and variations.
- Image, text, and code-file attachments in chat; local text files are appended to the prompt, and images are sent only when the user submits.
- Export chat / local data; clear chats, images, settings, and the API key from this browser.
- Installable progressive web app shell and static offline caching.

## Run locally

No build step or package manager is required. Download/clone the repository and serve its folder with a local static server, for example:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`. Opening `index.html` directly may work for the UI, but a local server is recommended for the PWA and API origin behavior.

## Connect Ollama (no API usage fee)

1. Install and start [Ollama](https://ollama.com/download).
2. Download a chat model in Ollama, for example `ollama pull llama3.2`.
3. In Yuko.ai, open **Settings → Ollama**, keep `http://localhost:11434`, and select **Test connection** or **Load models**.
4. If the browser reports a CORS/network error, configure Ollama's `OLLAMA_ORIGINS` environment variable to allow the exact origin hosting this app, then restart Ollama. Do not allow origins you do not trust.

For image understanding in chat, choose a local vision-capable Ollama model. Ollama's local image-generation behavior is not standardized by this app; the Image Studio currently calls OpenRouter's image endpoint.

## Connect OpenRouter

1. Create a key at [OpenRouter settings](https://openrouter.ai/settings/keys).
2. Open **Settings → OpenRouter**, paste the key, save settings, and load chat models.
3. Open **Image studio → Refresh** to load the available image-generation models.

Yuko sends the key in a request header directly to OpenRouter. It does not send the key to a Yuko server or include it in data exports. For convenience, the key is stored in this browser's `localStorage`, so clear it in Settings before using a shared browser profile. Browser extensions and malicious scripts that run on the same origin may still be able to read local storage; do not treat a browser-stored key as a server-side secret.

**Costs:** Yuko has no hosting fee of its own if you run it locally. Ollama runs on your device and has no per-request API charge, though it uses your hardware and electricity. OpenRouter chat may have free models subject to availability and limits; image generation generally requires credits. Confirm model pricing before submitting a generation request.

## Privacy model and limits

- Chat history, settings, and the OpenRouter key are stored in the current browser profile; they are not synchronized between devices.
- File bytes are held in memory while selected. Image/file uploads are not transmitted until you send a chat prompt or request image generation. Current chat history persists text plus attachment names, not image binary payloads.
- When you submit a prompt, attached images/text go directly to the configured provider. The selected provider processes the information according to its own privacy and retention terms.
- The GitHub Pages host serves the static source files; it does not receive prompts through app code. Normal hosting requests to GitHub still reveal standard web-request metadata.
- There is no Yuko login or remote sync. Browser storage can be cleared by the browser and has per-origin quotas.
- The Image Studio reference input uses the OpenRouter Images API with `input_references`; reference editing requires a model/provider endpoint that supports that parameter.

## GitHub Pages deployment

1. Push this source to the repository.
2. In **Settings → Pages**, choose **GitHub Actions** as the build/deployment source (or run the included workflow).
3. When deployment succeeds, open the Pages URL shown by GitHub. OpenRouter calls use HTTPS. If connecting to Ollama from a hosted URL, allow that exact site origin through Ollama's CORS configuration, and review the implications of a public browser app calling a device-local service.

The workflow deploys the repository root as a static site; no API secrets belong in repository files or Actions secrets for normal browser-side use.

## Development

This project is plain HTML, CSS, and JavaScript with no runtime dependencies. There is no package install or server build. Check JavaScript syntax with:

```bash
node --check app.js
```

## License

MIT — see [`LICENSE`](LICENSE).