declare module 'react-native-svg' {
  import * as React from 'react';
  import { ComponentType } from 'react';

  const Svg: ComponentType<any>;
  const Defs: ComponentType<any>;
  const LinearGradient: ComponentType<any>;
  const Path: ComponentType<any>;
  const Rect: ComponentType<any>;
  const Stop: ComponentType<any>;

  export { Defs, LinearGradient, Path, Rect, Stop };
  export default Svg;
}
