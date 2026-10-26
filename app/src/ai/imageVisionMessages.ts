export const imageVisionUnavailableText = (name: string) =>
  `小仓鼠，我这次只拿到了图片“${name}”的文件信息，看图连接还没有配置，所以没能看见内容>< 配好支持图片输入的“看图”连接后，再把它递给我一次吧。`;

export const imageVisionFailedText = (message: string) =>
  `小仓鼠，我这次没有看清图片：${message}。我们检查一下看图连接，或者稍后再试一次吧。`;

export const imageVisionSuccessText = (description: string) =>
  `I 从图片中看到：${description}`;
