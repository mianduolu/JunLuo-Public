export type YouPortraitAsset = {
  key: string;
  androidResourceName: string;
  source: number;
};

export const youPortraitAssets: YouPortraitAsset[] = [
  { key: 'you-portrait-angry', androidResourceName: 'you_portrait_angry', source: require('../../assets/images/you-portrait-angry.png') },
  { key: 'you-portrait-confused', androidResourceName: 'you_portrait_confused', source: require('../../assets/images/you-portrait-confused.png') },
  { key: 'you-portrait-happy', androidResourceName: 'you_portrait_happy', source: require('../../assets/images/you-portrait-happy.png') },
  { key: 'you-portrait-like', androidResourceName: 'you_portrait_like', source: require('../../assets/images/you-portrait-like.png') },
  { key: 'you-portrait-neutral', androidResourceName: 'you_portrait_neutral', source: require('../../assets/images/you-portrait-neutral.png') },
  { key: 'you-portrait-sad', androidResourceName: 'you_portrait_sad', source: require('../../assets/images/you-portrait-sad.png') },
  { key: 'you-portrait-speechless', androidResourceName: 'you_portrait_speechless', source: require('../../assets/images/you-portrait-speechless.png') },
  { key: 'you-portrait-surprised', androidResourceName: 'you_portrait_surprised', source: require('../../assets/images/you-portrait-surprised.png') },
];
