# 君落试用版：给 Codex 的换图说明

本说明对应君落当前源码结构。目录均相对于朋友自己的项目副本；这是源码交接说明，不代表试用 APK 已生成。

同名、同格式替换图片，再重新打包安装。已安装的 APK 不会读取电脑上的这些目录。尽量保留原画布比例、透明背景和文件名；若改名，要同时改静态资源引用。

## 主要图片

| 用途 | 源文件／目录 |
| --- | --- |
| 首页角色的普通心情立绘（24张） | `app/assets/images/baiyun-status/` |
| 首页角色的另一套心情立绘（24张） | `app/assets/images/black-cloud-status/` |
| 角色聊天头像／表情头像（8张） | `app/assets/images/you-portrait-*.png` |
| 自己的头像 | `app/assets/images/me-portrait-default.png` |
| 首页按钮图标 | `app/assets/images/icon-*.png` |
| 通话页头像／背景／按钮 | `app/assets/voice-call/` |
| 系统来电页原始图片 | `app/assets/语音通话/` |
| 桌面应用图标与启动图的源图 | `app/assets/app-icon.png` |

注意历史命名：`you-portrait-*.png` 实际给角色 I 使用，`me-portrait-default.png` 实际给自己 you 使用，勿反过来。共读按钮当前使用 `icon-gift.png`。

无需一次画齐24种表情时，可以先把自己的同一张立绘复制为各个现有心情文件名，之后再逐张替换；状态选择代码不因此改变。

## Android 另存的图片也要核对

1. 改角色头像后，在 `app` 目录运行已有 `npm run generate:you-portraits`。它生成原映射，并把 `you-portrait-*.png` 复制到 `android/app/src/main/res/drawable-nodpi/you_portrait_*.png`。普通 Gradle 打包不会自动运行这个生成器。
2. 手机限制浮层使用 `app/android/app/src/main/res/drawable-nodpi/baiyun_guard_*.png`，当前没有查到从首页心情图自动复制这组图的任务。按对应心情名替换这一组原生副本；不要只改首页图就宣称浮层已换。
3. 整机限制页头像另由原 Gradle `syncPhoneRestrictionAppearanceAssets` 自动复制两张源图 `you-portrait-neutral.png`、`me-portrait-default.png`。它不是全面同步所有原生图片的任务。
4. 系统来电图来自 `assets/语音通话/`，原生副本为 `res/drawable-nodpi/junluo_incoming_{avatar,background,answer_button,hangup_button}`，按原扩展名更新。App 内通话页的 `assets/voice-call/` 是另一份，不会自动互抄。
5. 桌面启动图标需更新原生 `res/mipmap-*` 中的 `ic_launcher*`，启动图需更新 `res/drawable-*` 中的 `splashscreen_logo.png`。只替换 `assets/app-icon.png` 后跑 Gradle，不会重新生成已有副本；由 Codex 按项目 Expo 54 的资源生成方式精确更新，再检查差异。

不要为了换图直接运行 `expo prebuild --clean` 重建整个 Android 工程。当前工程有定制原生代码，现有来电插件还会复制 Java 模板；换图应只更新对应资源，保留现役代码。

## 交付核对

- 在自己的项目副本改图，不修改别人的私人版。
- 安装后分别看首页、聊天、系统来电页和限制浮层，确认没有漏掉原生副本。
- 桌面图标与启动页单独看，不以 App 内图标正确代替。
- 只接收整理好的试用源码；模型 Key、生活备份、私人数据库、日志和开发机器的签名材料不随源码交接。模型连接由自己填写。
- 核心人格与图片是两件事：换图不会自动替换 Prompt 或所有页面里的固定称呼。

工程依据：`app/src/assets/homeImages.ts`、`app/src/voiceCall/voiceCallAssets.ts`、`app/scripts/generate-you-portraits.js`、`app/plugins/withJunLuoIncomingCall.js`、`app/android/app/build.gradle`、`app/app.json`。本说明来自源码核查；朋友设备上的最终效果须在她的安装包上验收。
