import { Image, Modal, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { useState } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  useBackgroundPreferences,
  type BackgroundImageFit,
  type BackgroundMode,
  type TextToneChoice,
} from '../backgrounds/BackgroundPreferences';
import { AppText as Text } from '../components/AppText';
import {
  WeatherOverlay,
  type CloudSpriteRenderingMode,
  type DustDiagnosticMode,
  type FogDiagnosticMode,
  type HailDiagnosticMode,
  type RainDiagnosticMode,
  type RainRenderingMode,
  type SnowDiagnosticMode,
  type ThunderstormLightningRenderingMode,
} from '../components/WeatherOverlay';
import { fontOptions } from '../fonts/fontCatalog';
import { useFontPreferences } from '../fonts/FontPreferences';
import { colors } from '../theme/colors';
import type { Navigate } from '../types/navigation';
import { skyThemes, type SkyPeriod } from '../utils/sky';

type Props = {
  navigate: Navigate;
  weatherAnimationsEnabled: boolean;
  setWeatherAnimationsEnabled: (enabled: boolean) => void;
};

const skyOptions: { label: string; value: SkyPeriod }[] = [
  { label: skyThemes.dawn.label, value: 'dawn' },
  { label: skyThemes.morning.label, value: 'morning' },
  { label: skyThemes.noon.label, value: 'noon' },
  { label: skyThemes.afternoon.label, value: 'afternoon' },
  { label: skyThemes.evening.label, value: 'evening' },
  { label: skyThemes.night.label, value: 'night' },
  { label: skyThemes.midnight.label, value: 'midnight' },
];

const backgroundModes: { label: string; value: BackgroundMode }[] = [
  { label: '随时间天空', value: 'sky' },
  { label: '固定天空', value: 'fixed' },
  { label: '自定义图片', value: 'image' },
];

const imageFitOptions: { label: string; value: BackgroundImageFit }[] = [
  { label: '填充', value: 'cover' },
  { label: '适应', value: 'contain' },
  { label: '平铺', value: 'repeat' },
];

const textToneOptions: { label: string; value: TextToneChoice }[] = [
  { label: '自动', value: 'auto' },
  { label: '浅色', value: 'light' },
  { label: '深色', value: 'dark' },
];

const WEATHER_PREVIEW_ENABLED =
  __DEV__
  || process.env.EXPO_PUBLIC_JUNLUO_WEATHER_PREVIEW === '1';

function getTextToneLabel(option: { label: string; value: TextToneChoice }, mode: BackgroundMode) {
  return mode === 'image' && option.value === 'auto' ? '默认浅色' : option.label;
}

export function AppearanceSettingsScreen({
  navigate,
  weatherAnimationsEnabled,
  setWeatherAnimationsEnabled,
}: Props) {
  const [isWeatherPreviewVisible, setIsWeatherPreviewVisible] = useState(false);
  const [weatherPreviewKind, setWeatherPreviewKind] = useState<'rain' | 'snow' | 'fog' | 'hail' | 'thunderstorm' | 'cloudy' | 'dust' | 'stars'>('rain');
  const [weatherPreviewMode, setWeatherPreviewMode] = useState<RainRenderingMode>('legacy');
  const [rainDiagnosticMode, setRainDiagnosticMode] = useState<RainDiagnosticMode>();
  const [hailDiagnosticMode, setHailDiagnosticMode] = useState<HailDiagnosticMode>();
  const [snowDiagnosticMode, setSnowDiagnosticMode] = useState<SnowDiagnosticMode>();
  const [dustDiagnosticMode, setDustDiagnosticMode] = useState<DustDiagnosticMode>();
  const [fogDiagnosticMode, setFogDiagnosticMode] = useState<FogDiagnosticMode>('full');
  const [cloudSpriteMode, setCloudSpriteMode] = useState<CloudSpriteRenderingMode>('rebuild');
  const [thunderstormLightningMode, setThunderstormLightningMode] = useState<ThunderstormLightningRenderingMode>('cached-images');
  const { choice: fontChoice, isFontReady, setChoice: setFontChoice } = useFontPreferences();
  const {
    settings: background,
    setMode: setBackgroundMode,
    setFixedPeriod,
    setImageFit,
    setHeaderTextTone,
    setExposedLabelTextTone,
    chooseImage,
    removeImage,
  } = useBackgroundPreferences();

  return (
    <View style={styles.page}>
      <View style={styles.header}>
        <Pressable onPress={() => navigate('settings')} style={styles.backButton}>
          <Text style={styles.backText}>回</Text>
        </Pressable>
        <Text style={styles.title}>外观衣柜</Text>
        <View style={styles.backButton} />
      </View>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        style={styles.scroll}
      >
        <View style={styles.card}>
          <Text style={styles.cardTitle}>字体衣柜</Text>
          <Text style={styles.cardText}>默认跟随手机系统。新字体放进 assets/fonts 后，在字体清单登记即可加入选择。</Text>
          <Text style={styles.fontPreview}>君落和白云小姐，今天也一起慢慢来。</Text>
          <View style={styles.fontOptions}>
            {fontOptions.map((option) => {
              const isActive = option.value === fontChoice;
              return (
                <Pressable
                  key={option.value}
                  onPress={() => setFontChoice(option.value)}
                  style={[styles.fontButton, isActive ? styles.fontButtonActive : null]}
                >
                  <Text style={[styles.fontName, isActive ? styles.fontNameActive : null]}>{option.label}</Text>
                  <Text style={[styles.fontDescription, isActive ? styles.fontDescriptionActive : null]}>
                    {option.description}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {fontChoice === 'xiaolai' && !isFontReady ? <Text style={styles.loadingText}>小赖字体加载中...</Text> : null}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>背景衣柜</Text>
          <Text style={styles.cardText}>选择的背景会同时应用到首页与聊天页。自定义图片模式下，首页天气动画暂不叠加。</Text>
          <Text style={styles.controlLabel}>背景模式</Text>
          <View style={styles.optionGrid}>
            {backgroundModes.map((option) => {
              const isActive = option.value === background.mode;
              const isUnavailable = option.value === 'image' && !background.imageUri;
              return (
                <Pressable
                  key={option.value}
                  disabled={isUnavailable}
                  onPress={() => setBackgroundMode(option.value)}
                  style={[
                    styles.optionButton,
                    isActive ? styles.optionButtonActive : null,
                    isUnavailable ? styles.optionButtonDisabled : null,
                  ]}
                >
                  <Text style={[styles.optionText, isActive ? styles.optionTextActive : null]}>{option.label}</Text>
                </Pressable>
              );
            })}
          </View>
          {background.mode === 'fixed' ? (
            <>
              <Text style={styles.controlLabel}>固定天空时段</Text>
              <View style={styles.optionGrid}>
                {skyOptions.map((option) => {
                  const isActive = option.value === background.fixedPeriod;
                  return (
                    <Pressable
                      key={option.value}
                      onPress={() => setFixedPeriod(option.value)}
                      style={[styles.optionButton, isActive ? styles.optionButtonActive : null]}
                    >
                      <Text style={[styles.optionText, isActive ? styles.optionTextActive : null]}>{option.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </>
          ) : null}
          <Text style={styles.controlLabel}>自定义图片</Text>
          {background.imageUri ? <Image source={{ uri: background.imageUri }} style={styles.backgroundPreview} /> : null}
          <View style={styles.actionRow}>
            <Pressable onPress={() => void chooseImage()} style={styles.actionButton}>
              <Text style={styles.actionText}>{background.imageUri ? '更换图片' : '从相册选择'}</Text>
            </Pressable>
            {background.imageUri ? (
              <Pressable onPress={() => void removeImage()} style={[styles.actionButton, styles.removeButton]}>
                <Text style={styles.removeText}>移除图片</Text>
              </Pressable>
            ) : null}
          </View>
          {background.imageUri ? (
            <>
              <Text style={styles.controlLabel}>图片显示方式</Text>
              <View style={styles.optionGrid}>
                {imageFitOptions.map((option) => {
                  const isActive = option.value === background.imageFit;
                  return (
                    <Pressable
                      key={option.value}
                      onPress={() => setImageFit(option.value)}
                      style={[styles.optionButton, isActive ? styles.optionButtonActive : null]}
                    >
                      <Text style={[styles.optionText, isActive ? styles.optionTextActive : null]}>{option.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </>
          ) : null}
          <Text style={styles.controlLabel}>顶部时间文字</Text>
          <View style={styles.optionGrid}>
            {textToneOptions.map((option) => {
              const isActive = option.value === background.headerTextTone;
              return (
                <Pressable
                  key={option.value}
                  onPress={() => setHeaderTextTone(option.value)}
                  style={[styles.optionButton, isActive ? styles.optionButtonActive : null]}
                >
                  <Text style={[styles.optionText, isActive ? styles.optionTextActive : null]}>
                    {getTextToneLabel(option, background.mode)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={styles.controlLabel}>首页功能标签文字</Text>
          <View style={styles.optionGrid}>
            {textToneOptions.map((option) => {
              const isActive = option.value === background.exposedLabelTextTone;
              return (
                <Pressable
                  key={option.value}
                  onPress={() => setExposedLabelTextTone(option.value)}
                  style={[styles.optionButton, isActive ? styles.optionButtonActive : null]}
                >
                  <Text style={[styles.optionText, isActive ? styles.optionTextActive : null]}>
                    {getTextToneLabel(option, background.mode)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {background.mode === 'image' ? (
            <Text style={styles.helpText}>图片模式默认使用浅色文字；图片偏亮时，可以分别切换为深色以保持清楚。</Text>
          ) : null}
        </View>

        <View style={styles.card}>
          <View style={styles.toggleRow}>
            <View style={styles.toggleCopy}>
              <Text style={styles.cardTitle}>天气动画</Text>
              <Text style={styles.cardText}>在天空背景上显示与实际天气对应的动态效果</Text>
              <Text style={styles.helpText}>自定义图片背景暂不叠加天气动画。</Text>
            </View>
            <Switch
              value={weatherAnimationsEnabled}
              onValueChange={setWeatherAnimationsEnabled}
              trackColor={{ false: '#E5E1DE', true: '#FFC1B4' }}
              thumbColor={weatherAnimationsEnabled ? '#FF8F79' : '#FFFFFF'}
            />
          </View>
          {WEATHER_PREVIEW_ENABLED ? (
            <>
            <Pressable
              onPress={() => {
                setWeatherPreviewKind('rain');
                setWeatherPreviewMode('canvas');
                setRainDiagnosticMode(undefined);
                setIsWeatherPreviewVisible(true);
              }}
              style={styles.weatherPreviewButton}
            >
              <Text style={styles.weatherPreviewButtonText}>雨天预览</Text>
            </Pressable>
          {WEATHER_PREVIEW_ENABLED ? (
            <Pressable
              onPress={() => {
                setWeatherPreviewKind('snow');
                setWeatherPreviewMode('canvas');
                setSnowDiagnosticMode(undefined);
                setIsWeatherPreviewVisible(true);
              }}
              style={styles.weatherPreviewButton}
            >
              <Text style={styles.weatherPreviewButtonText}>雪天预览</Text>
            </Pressable>
          ) : null}
            <Pressable
              onPress={() => {
                setWeatherPreviewKind('fog');
                setWeatherPreviewMode('canvas');
                setIsWeatherPreviewVisible(true);
              }}
              style={styles.weatherPreviewButton}
            >
              <Text style={styles.weatherPreviewButtonText}>雾天预览</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setWeatherPreviewKind('hail');
                setWeatherPreviewMode('canvas');
                setHailDiagnosticMode(undefined);
                setIsWeatherPreviewVisible(true);
              }}
              style={styles.weatherPreviewButton}
            >
              <Text style={styles.weatherPreviewButtonText}>冰雹预览</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setWeatherPreviewKind('thunderstorm');
                setWeatherPreviewMode('canvas');
                setIsWeatherPreviewVisible(true);
              }}
              style={styles.weatherPreviewButton}
            >
              <Text style={styles.weatherPreviewButtonText}>雷阵雨预览</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setWeatherPreviewKind('cloudy');
                setWeatherPreviewMode('canvas');
                setIsWeatherPreviewVisible(true);
              }}
              style={styles.weatherPreviewButton}
            >
              <Text style={styles.weatherPreviewButtonText}>云天预览</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setWeatherPreviewKind('dust');
                setWeatherPreviewMode('canvas');
                setDustDiagnosticMode(undefined);
                setIsWeatherPreviewVisible(true);
              }}
              style={styles.weatherPreviewButton}
            >
              <Text style={styles.weatherPreviewButtonText}>沙尘预览</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setWeatherPreviewKind('stars');
                setWeatherPreviewMode('canvas');
                setIsWeatherPreviewVisible(true);
              }}
              style={styles.weatherPreviewButton}
            >
              <Text style={styles.weatherPreviewButtonText}>星空预览</Text>
            </Pressable>





            </>
          ) : null}
        </View>
      </ScrollView>
      {WEATHER_PREVIEW_ENABLED && isWeatherPreviewVisible ? (
        <Modal
          animationType="fade"
          onRequestClose={() => setIsWeatherPreviewVisible(false)}
          visible
        >
          <View style={styles.weatherPreviewPage}>
            <WeatherOverlay
              cloudRenderingMode={weatherPreviewMode}
              diagnosticCloudSpriteMode={
                weatherPreviewKind === 'cloudy' || weatherPreviewKind === 'thunderstorm'
                  ? cloudSpriteMode
                  : undefined
              }
              diagnosticDustMode={weatherPreviewKind === 'dust' ? dustDiagnosticMode : undefined}
              diagnosticFogMode={weatherPreviewKind === 'fog' ? fogDiagnosticMode : undefined}
              diagnosticHailMode={weatherPreviewKind === 'hail' ? hailDiagnosticMode : undefined}
              diagnosticRainMode={weatherPreviewKind === 'rain' ? rainDiagnosticMode : undefined}
              diagnosticSnowMode={weatherPreviewKind === 'snow' ? snowDiagnosticMode : undefined}
              diagnosticThunderstormLightningMode={
                weatherPreviewKind === 'thunderstorm' && thunderstormLightningMode === 'paths'
                  ? 'paths'
                  : undefined
              }
              dustRenderingMode={weatherPreviewMode}
              fogRenderingMode={weatherPreviewMode}
              hailRenderingMode={weatherPreviewMode}
              kind={weatherPreviewKind === 'stars' ? 'clear' : weatherPreviewKind}
              rainRenderingMode={weatherPreviewMode}
              snowRenderingMode={weatherPreviewMode}
              starRenderingMode={weatherPreviewMode}
              theme={weatherPreviewKind === 'stars' ? skyThemes.night : skyThemes.afternoon}
            />
            <SafeAreaView style={styles.weatherPreviewControls}>
              <View style={styles.weatherPreviewHeader}>
                <View style={styles.weatherPreviewHeading}>
                  <Text style={styles.weatherPreviewTitle}>
                    {weatherPreviewKind === 'rain' ? '雨天动画预览' : weatherPreviewKind === 'snow' ? '雪天动画预览' : weatherPreviewKind === 'fog' ? '雾天动画预览' : weatherPreviewKind === 'hail' ? '冰雹动画预览' : weatherPreviewKind === 'thunderstorm' ? '雷阵雨动画预览' : weatherPreviewKind === 'cloudy' ? '云天动画预览' : weatherPreviewKind === 'dust' ? '沙尘动画预览' : '星空动画预览'}
                  </Text>
                  <Text style={styles.weatherPreviewMeta}>
                    {weatherPreviewKind === 'rain' && rainDiagnosticMode === 'canvas-static'
                      ? 'Skia 固定逻辑帧'
                      : weatherPreviewKind === 'rain' && rainDiagnosticMode === 'native-static'
                        ? '普通 Android View 固定逻辑帧'
                        : weatherPreviewKind === 'rain' && rainDiagnosticMode === 'native-dynamic'
                          ? '普通 Android View · 24fps'
                    : weatherPreviewKind === 'hail' && hailDiagnosticMode === 'canvas-static'
                      ? 'Skia 固定逻辑帧'
                      : weatherPreviewKind === 'hail' && hailDiagnosticMode === 'native-static'
                        ? '普通 Android View 固定逻辑帧'
                        : weatherPreviewKind === 'hail' && hailDiagnosticMode === 'native-dynamic'
                          ? '普通 Android View · 24fps'
                    : weatherPreviewKind === 'snow' && snowDiagnosticMode === 'canvas-static'
                      ? 'Skia 固定逻辑帧'
                      : weatherPreviewKind === 'snow' && snowDiagnosticMode === 'native-static'
                        ? '普通 Android View 固定逻辑帧'
                        : weatherPreviewKind === 'snow' && snowDiagnosticMode === 'native-dynamic'
                          ? '普通 Android View · 24fps'
                    : weatherPreviewKind === 'dust'
                      ? dustDiagnosticMode === 'canvas-static'
                        ? 'Skia 固定逻辑帧'
                        : dustDiagnosticMode === 'native-static'
                          ? '普通 Android View 固定逻辑帧'
                          : dustDiagnosticMode === 'native-dynamic'
                            ? '普通 Android View · 12fps'
                            : '完整动态沙尘'
                    : weatherPreviewKind === 'fog'
                      ? fogDiagnosticMode === 'canvas-static'
                        ? '画布固定逻辑帧'
                        : fogDiagnosticMode === 'native-static'
                          ? '普通 Android View 固定逻辑帧'
                          : fogDiagnosticMode === 'native-dynamic-4x'
                            ? '普通 Android View · 12fps · alpha 4×'
                            : fogDiagnosticMode === 'native-dynamic-2x'
                              ? '普通 Android View · 12fps · alpha 2×'
                              : fogDiagnosticMode === 'native-dynamic-115x'
                                ? '普通 Android View · 12fps · alpha 1.15×'
                                : fogDiagnosticMode === 'native-dynamic'
                                  ? '普通 Android View · 12fps · alpha 1×'
                            : fogDiagnosticMode === 'static-blurred'
                        ? '静态位置 · 保留全部模糊节点'
                        : fogDiagnosticMode === 'moving-solid'
                          ? '完整移动 · 移除模糊节点'
                          : '完整动态雾'
                    : weatherPreviewKind === 'thunderstorm'
                      ? `${cloudSpriteMode === 'stable-pool' ? '稳定雷云纹理' : '原版重建雷云'} · ${thunderstormLightningMode === 'cached-images' ? '有界缓存闪电' : '原版路径闪电'}`
                      : weatherPreviewKind === 'cloudy'
                        ? cloudSpriteMode === 'stable-pool'
                          ? '单槽稳定云纹理'
                          : '原版重建云纹理'
                      : weatherPreviewMode === 'legacy'
                      ? '原版星星'
                      : '画布内部更新'}
                  </Text>
                </View>
                <Pressable
                  onPress={() => setIsWeatherPreviewVisible(false)}
                  style={styles.weatherPreviewClose}
                >
                  <Text style={styles.weatherPreviewCloseText}>关闭</Text>
                </Pressable>
              </View>
              {weatherPreviewKind === 'rain' || weatherPreviewKind === 'hail' || weatherPreviewKind === 'snow' ? (
                <View style={styles.weatherPreviewModeRow}>
                  {([
                    { label: weatherPreviewKind === 'rain' ? '原版雨滴' : weatherPreviewKind === 'hail' ? '原版冰雹' : '原版雪花', mode: undefined },
                    { label: '画布固定帧', mode: 'canvas-static' },
                    { label: '原生固定帧', mode: 'native-static' },
                    { label: '原生动态', mode: 'native-dynamic' },
                  ] as const).map((option) => {
                    const diagnosticMode = weatherPreviewKind === 'rain'
                      ? rainDiagnosticMode
                      : weatherPreviewKind === 'hail'
                        ? hailDiagnosticMode
                        : snowDiagnosticMode;
                    const isActive = diagnosticMode === option.mode;
                    return (
                      <Pressable
                        key={option.label}
                        onPress={() => {
                          if (weatherPreviewKind === 'rain') {
                            setRainDiagnosticMode(option.mode);
                          } else if (weatherPreviewKind === 'hail') {
                            setHailDiagnosticMode(option.mode);
                          } else {
                            setSnowDiagnosticMode(option.mode);
                          }
                        }}
                        style={[
                          styles.weatherPreviewModeButton,
                          isActive ? styles.weatherPreviewModeButtonActive : null,
                        ]}
                      >
                        <Text
                          style={[
                            styles.weatherPreviewModeText,
                            isActive ? styles.weatherPreviewModeTextActive : null,
                          ]}
                        >
                          {option.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              ) : weatherPreviewKind === 'fog' ? (
                <View style={styles.weatherPreviewModeStack}>
                  <View style={styles.weatherPreviewModeRow}>
                    {([
                      { label: '完整动态雾', mode: 'full' },
                      { label: '静态模糊节点', mode: 'static-blurred' },
                      { label: '动态无模糊', mode: 'moving-solid' },
                    ] as const).map((option) => {
                      const isActive = fogDiagnosticMode === option.mode;
                      return (
                        <Pressable
                          key={option.mode}
                          onPress={() => setFogDiagnosticMode(option.mode)}
                          style={[
                            styles.weatherPreviewModeButton,
                            isActive ? styles.weatherPreviewModeButtonActive : null,
                          ]}
                        >
                          <Text
                            style={[
                              styles.weatherPreviewModeText,
                              isActive ? styles.weatherPreviewModeTextActive : null,
                            ]}
                          >
                            {option.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                  <View style={styles.weatherPreviewModeRow}>
                    {([
                      { label: '26粒画布固定', mode: 'canvas-static' },
                      { label: '26粒贴片固定', mode: 'native-static' },
                    ] as const).map((option) => {
                      const isActive = fogDiagnosticMode === option.mode;
                      return (
                        <Pressable
                          key={option.mode}
                          onPress={() => setFogDiagnosticMode(option.mode)}
                          style={[
                            styles.weatherPreviewModeButton,
                            isActive ? styles.weatherPreviewModeButtonActive : null,
                          ]}
                        >
                          <Text
                            style={[
                              styles.weatherPreviewModeText,
                              isActive ? styles.weatherPreviewModeTextActive : null,
                            ]}
                          >
                            {option.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                  <View style={styles.weatherPreviewModeRow}>
                    {([
                      { label: '动态 1×', mode: 'native-dynamic' },
                      { label: '动态 1.15×', mode: 'native-dynamic-115x' },
                      { label: '动态 2×', mode: 'native-dynamic-2x' },
                      { label: '动态 4×', mode: 'native-dynamic-4x' },
                    ] as const).map((option) => {
                      const isActive = fogDiagnosticMode === option.mode;
                      return (
                        <Pressable
                          key={option.mode}
                          onPress={() => setFogDiagnosticMode(option.mode)}
                          style={[
                            styles.weatherPreviewModeButton,
                            isActive ? styles.weatherPreviewModeButtonActive : null,
                          ]}
                        >
                          <Text
                            style={[
                              styles.weatherPreviewModeText,
                              isActive ? styles.weatherPreviewModeTextActive : null,
                            ]}
                          >
                            {option.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              ) : weatherPreviewKind === 'dust' ? (
                <View style={styles.weatherPreviewModeRow}>
                  {([
                    { label: '完整动态沙尘', mode: undefined },
                    { label: '画布固定帧', mode: 'canvas-static' },
                    { label: '原生固定帧', mode: 'native-static' },
                    { label: '原生动态', mode: 'native-dynamic' },
                  ] as const).map((option) => {
                    const isActive = dustDiagnosticMode === option.mode;
                    return (
                      <Pressable
                        key={option.label}
                        onPress={() => setDustDiagnosticMode(option.mode)}
                        style={[
                          styles.weatherPreviewModeButton,
                          isActive ? styles.weatherPreviewModeButtonActive : null,
                        ]}
                      >
                        <Text
                          style={[
                            styles.weatherPreviewModeText,
                            isActive ? styles.weatherPreviewModeTextActive : null,
                          ]}
                        >
                          {option.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              ) : weatherPreviewKind === 'cloudy' ? (
                <View style={styles.weatherPreviewModeRow}>
                  {([
                    { label: '原版重建云纹理', mode: 'rebuild' },
                    { label: '单槽稳定云纹理', mode: 'stable-pool' },
                  ] as const).map((option) => {
                    const isActive = cloudSpriteMode === option.mode;
                    return (
                      <Pressable
                        key={option.mode}
                        onPress={() => setCloudSpriteMode(option.mode)}
                        style={[
                          styles.weatherPreviewModeButton,
                          isActive ? styles.weatherPreviewModeButtonActive : null,
                        ]}
                      >
                        <Text
                          style={[
                            styles.weatherPreviewModeText,
                            isActive ? styles.weatherPreviewModeTextActive : null,
                          ]}
                        >
                          {option.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              ) : weatherPreviewKind === 'thunderstorm' ? (
                <View style={styles.weatherPreviewModeStack}>
                  <View style={styles.weatherPreviewModeRow}>
                    {([
                      { label: '原版重建雷云', mode: 'rebuild' },
                      { label: '稳定雷云纹理', mode: 'stable-pool' },
                    ] as const).map((option) => {
                      const isActive = cloudSpriteMode === option.mode;
                      return (
                        <Pressable
                          key={option.mode}
                          onPress={() => setCloudSpriteMode(option.mode)}
                          style={[
                            styles.weatherPreviewModeButton,
                            isActive ? styles.weatherPreviewModeButtonActive : null,
                          ]}
                        >
                          <Text
                            style={[
                              styles.weatherPreviewModeText,
                              isActive ? styles.weatherPreviewModeTextActive : null,
                            ]}
                          >
                            {option.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                  <View style={styles.weatherPreviewModeRow}>
                    {([
                      { label: '原版路径闪电', mode: 'paths' },
                      { label: '有界缓存闪电', mode: 'cached-images' },
                    ] as const).map((option) => {
                      const isActive = thunderstormLightningMode === option.mode;
                      return (
                        <Pressable
                          key={option.mode}
                          onPress={() => setThunderstormLightningMode(option.mode)}
                          style={[
                            styles.weatherPreviewModeButton,
                            isActive ? styles.weatherPreviewModeButtonActive : null,
                          ]}
                        >
                          <Text
                            style={[
                              styles.weatherPreviewModeText,
                              isActive ? styles.weatherPreviewModeTextActive : null,
                            ]}
                          >
                            {option.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              ) : <View style={styles.weatherPreviewModeRow}>
                {(['legacy', 'canvas'] as const).map((mode) => {
                  const isActive = weatherPreviewMode === mode;
                  return (
                    <Pressable
                      key={mode}
                      onPress={() => setWeatherPreviewMode(mode)}
                      style={[
                        styles.weatherPreviewModeButton,
                        isActive ? styles.weatherPreviewModeButtonActive : null,
                      ]}
                    >
                      <Text
                        style={[
                          styles.weatherPreviewModeText,
                          isActive ? styles.weatherPreviewModeTextActive : null,
                        ]}
                      >
                        {mode === 'legacy'
                          ? '原版星星'
                          : '画布实验'}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>}
            </SafeAreaView>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, paddingTop: 42, paddingHorizontal: 18, backgroundColor: '#FFF9F4' },
  header: { height: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 },
  scroll: { flex: 1 },
  content: { paddingBottom: 24 },
  backButton: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.cardStrong },
  backText: { color: colors.ink, fontWeight: '900' },
  title: { color: colors.ink, fontSize: 27, fontWeight: '900' },
  card: { borderRadius: 22, backgroundColor: '#FFFFFF', padding: 16, marginBottom: 12, borderWidth: 1, borderColor: '#FFE0D7' },
  cardTitle: { color: colors.ink, fontSize: 16, fontWeight: '900', marginBottom: 7 },
  cardText: { color: colors.muted, fontSize: 14, lineHeight: 21 },
  fontPreview: { color: colors.ink, fontSize: 19, lineHeight: 29, marginVertical: 14 },
  fontOptions: { gap: 8 },
  fontButton: { minHeight: 58, borderRadius: 16, justifyContent: 'center', paddingHorizontal: 14, backgroundColor: '#FFF8F4', borderWidth: 1, borderColor: '#FFE0D7' },
  fontButtonActive: { backgroundColor: '#FFF0EC', borderColor: '#FF9A8B' },
  fontName: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  fontNameActive: { color: '#E96556' },
  fontDescription: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  fontDescriptionActive: { color: '#C56B61' },
  loadingText: { color: colors.muted, fontSize: 12, marginTop: 9 },
  controlLabel: { color: colors.ink, fontSize: 14, fontWeight: '800', marginTop: 16, marginBottom: 8 },
  backgroundPreview: { width: '100%', height: 120, borderRadius: 15, marginBottom: 10 },
  actionRow: { flexDirection: 'row', gap: 8 },
  actionButton: { minHeight: 40, borderRadius: 20, paddingHorizontal: 16, justifyContent: 'center', backgroundColor: '#FF9A8B' },
  actionText: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  removeButton: { backgroundColor: '#FFF2EE', borderWidth: 1, borderColor: '#FFE0D7' },
  removeText: { color: '#D2685B', fontSize: 14, fontWeight: '700' },
  helpText: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 10 },
  optionGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  optionButton: { minWidth: 64, minHeight: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFF2EE', borderWidth: 1, borderColor: '#FFE0D7', paddingHorizontal: 12 },
  optionButtonActive: { backgroundColor: '#FF9A8B', borderColor: '#FF8A78' },
  optionButtonDisabled: { opacity: 0.45 },
  optionText: { color: colors.ink, fontSize: 14, fontWeight: '700' },
  optionTextActive: { color: '#FFFFFF' },
  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16 },
  toggleCopy: { flex: 1 },
  weatherPreviewButton: {
    minHeight: 44,
    marginTop: 16,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFF2EE',
    borderWidth: 1,
    borderColor: '#FFB5A7',
  },
  weatherPreviewButtonText: { color: '#D2685B', fontSize: 14, fontWeight: '700' },
  weatherPreviewPage: { flex: 1, backgroundColor: '#A7C6E6' },
  weatherPreviewControls: {
    flex: 1,
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingBottom: 24,
  },
  weatherPreviewHeader: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
  },
  weatherPreviewHeading: { flex: 1 },
  weatherPreviewTitle: { color: '#FFFFFF', fontSize: 22, fontWeight: '800' },
  weatherPreviewMeta: { color: 'rgba(255,255,255,0.86)', fontSize: 13, marginTop: 3 },
  weatherPreviewClose: {
    minWidth: 64,
    minHeight: 40,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(28,42,65,0.38)',
  },
  weatherPreviewCloseText: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  weatherPreviewModeRow: {
    flexDirection: 'row',
    alignSelf: 'center',
    gap: 8,
    padding: 6,
    borderRadius: 20,
    backgroundColor: 'rgba(28,42,65,0.38)',
  },
  weatherPreviewModeStack: { alignSelf: 'center', gap: 8 },
  weatherPreviewModeButton: {
    minWidth: 86,
    minHeight: 42,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  weatherPreviewModeButtonActive: { backgroundColor: 'rgba(255,255,255,0.94)' },
  weatherPreviewModeText: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  weatherPreviewModeTextActive: { color: '#3F5571' },
});
