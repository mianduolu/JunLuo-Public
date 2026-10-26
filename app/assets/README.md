# JunLuo Assets

This directory is the central home for bundled replaceable assets.

Current layout:

- `backgrounds/`: bundled background assets and background notes.
- `fonts/`: bundled fonts. Add font files here, then register them in `src/fonts/fontCatalog.ts`.
- `images/`: bundled icons, character portraits, and feature images.
- `sounds/`: bundled sound assets such as alarm tones, notification sounds, and voice clips.
- `app-icon.png`: bundled app icon.

Important:

- Replacing files in `app/assets` usually requires rebuilding and reinstalling the app.
- React Native and Expo need static asset paths for bundled assets, so adding a file may also require registering it in code.
- Keep licenses next to third-party fonts, images, and audio files.
- Runtime user-picked files should be copied into the app document directory instead of being placed here.
