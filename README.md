# 君落 · 公开试用源码

这是君落 Android 陪伴 App 的公开试用版本，基于 React Native、Expo SDK 54 和 TypeScript。它使用独立仓库与新的 Git 历史维护。

**直接体验：** 下载[君落试用 APK](https://github.com/mianduolu/JunLuo-Public/releases/download/trial-2026-10-27/JunLuo-Trial-20261027.apk)，或打开[本次发布页](https://github.com/mianduolu/JunLuo-Public/releases/tag/trial-2026-10-27)。安装与首次设置见 `USING_TRIAL.md`。源码保留给想换图、改代码和自己打包的人。

## 这份源码包含什么

- Android App 的现有功能代码、原生模块和必要构建脚本。
- “设置 → 相处与表情 → 角色核心设定”：填写后，以这份核心替代内置的身份、性格、外形和固定背景；相处补充及“关于我”仍分开填写。
- 原有图片资源和换图说明，方便使用者自己的 Codex 修改后重新打包。

默认示例仍有“白云小姐／小仓鼠”的图片、界面称呼和部分本地固定台词。核心设定接通不代表这些默认显示都已自动改名；完全换成自己的角色时，按 `CUSTOMIZATION.md` 核对对应源文件。这里没有原使用者的聊天、记忆数据库、私人录音或模型凭据。

本仓库当前以 Android 源码及试用 APK 为范围，没有随包部署后端、电话服务、桌面客户端或资料中继。部分功能需要另外配置相应服务、Android 权限和可用模型额度。安装包已完成构建、签名和包级检查；朋友机型上的完整功能体验仍需实际使用确认。

## 本地开发

1. 准备 Node.js、JDK 17、Android SDK 及相应的 Android 开发环境。
2. 在 `app` 目录执行 `npm ci`。原有 `postinstall` 会应用本项目需要的依赖修补；不要跳过后直接认定原生行为一致。
3. 自己配置 Android SDK 路径及本机签名材料，真实值不提交。原签名文件没有随源码提供。
4. 在 App 的模型设置里填写自己的连接与 Key。不要把 Key 写进公开源码或 `EXPO_PUBLIC_*` 环境变量。
5. 开发可使用 `npm start` 和 `npm run android`；已有定制 Android 工程，不用 `expo prebuild --clean` 覆盖它。

本副本默认名称为“君落试用”，applicationId 为 `com.anonymous.junluo.trial`，与原君落分别保存资料。打包自己的版本时使用自己的签名；需要再次换包名时，同时核对自身用量和活动筛选中的包名识别，不全局替换 Java namespace。

现役 Release 构建还需先运行 `:app:compileReleaseReactContextLifecycle`，再运行 `:app:assembleRelease`，以准备原 RN 生命周期替换类。这里保留这条已使用的构建顺序，没有宣称已修好 Gradle 的全部任务依赖。

Windows 上本次原生工具执行在带空格的 JDK 路径／中文临时目录组合下失败，改用短路径 JDK 和英文临时目录后通过。请按自己的本机目录配置，不把维护者的路径写回源码；这不是 App 运行时依赖。

## 功能更新

私用版本继续优先开发。已验证、允许公开的功能改动会接入本仓库，保留公开版核心设定和使用者自己的图片；两边同时改到同一处时先核对合并，再验证发布。

具体流程见 `UPDATING.md`。代码推送、APK 构建和手机安装是不同步骤；获取代码更新不会自动安装 App，也不会交换双方的聊天、记忆或 Key。

本仓库未附加新的开源许可证。第三方字体的原许可文件保留在 `app/assets/fonts/`；依赖保留各自许可。

