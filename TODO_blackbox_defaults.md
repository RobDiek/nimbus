# Blackbox default provider/model/base URL — TODO

- [ ] UI: add "Blackbox" provider option to `public/app.html`
- [ ] UI: persist provider correctly from `public/js/app.js` (alias mapping)
- [ ] Backend: implement `blackbox` alias in `src/agent.js` (treat as `custom`)
- [ ] Backend: set default settings (provider/model/custom_base_url = https://api.blackbox.ai) on first startup in `src/server.js`
- [ ] Smoke test:
  - [ ] GET /api/status shows default provider alias + model
  - [ ] GET /api/settings shows customBaseUrl = https://api.blackbox.ai
  - [ ] POST /api/chat with model `blackboxai/openai/gpt-5.5` no longer shows "open-source only" (assuming valid key)
