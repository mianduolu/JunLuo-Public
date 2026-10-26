# Fonts

The app follows the system font by default. Optional bundled fonts live in this directory.

Included font:

- `Xiaolai-Regular.ttf`: Xiaolai / small handwriting font, from the official `lxgw/kose-font` release `v3.126`.
- `OFL-Xiaolai.txt`: the accompanying SIL Open Font License 1.1 text.

To add another selectable font:

1. Place the `.ttf` or `.otf` file in this directory and keep its license file alongside it.
2. Register its static `require(...)`, selection id, and label in `src/fonts/fontCatalog.ts`.
3. Add the family mapping in `getFontFamily(...)`.

Expo bundles font files referenced statically by the app, so dropping in a file without registering it does not expose it in settings.
