# Sounds

Bundled sound assets live here.

Current strong-alarm fallback sound:

- `alarm-strong.wav`

Other suggested filenames:

- `notification-message.wav`
- `voice-*.wav`

Notes:

- Replacing these files usually requires rebuilding and reinstalling the app.
- If a sound is used by Android native code, the config plugin must copy it into Android resources during `expo prebuild`.
- Keep source and license notes beside third-party audio.
- `alarm-strong.wav` is a generated local chime. It starts gently, then becomes more urgent, so the alarm does not jump straight into a startling sound.
- It is used only when Android cannot provide a system alarm/ringtone sound.
