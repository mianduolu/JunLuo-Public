import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg from 'react-native-svg/src/elements/Svg';
import Circle from 'react-native-svg/src/elements/Circle';
import G from 'react-native-svg/src/elements/G';
import Path from 'react-native-svg/src/elements/Path';
import Rect from 'react-native-svg/src/elements/Rect';
import SvgText from 'react-native-svg/src/elements/Text';

import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import { colors } from '../theme/colors';
import type {
  MemoryStarGraph,
  MemoryStarGraphEdge,
  MemoryStarGraphFilter,
  MemoryStarGraphNode,
} from './memoryStarGraph';
import type { MemoryEntry } from './memoryStore';

type Props = {
  graph: MemoryStarGraph | null;
  loading?: boolean;
  modeLabel: string;
  onClose: () => void;
  onDeleteEdge: (edgeId: string) => void;
  onFilterChange: (filters: MemoryStarGraphFilter[]) => void;
  onOpenMemory: (memory: MemoryEntry) => void;
  onOpenTopic?: (topicKey: string, label: string) => void;
  onReverseEdge: (edgeId: string) => void;
  onSearchChange: (query: string) => void;
  onSelectEdge: (edgeId: string | null) => void;
  onSelectNode: (nodeId: string | null) => void;
  onSoftenEdge: (edgeId: string) => void;
  onToggleMode: () => void;
  query: string;
  selectedEdgeId: string | null;
  selectedFilters: MemoryStarGraphFilter[];
  selectedNodeId: string | null;
};

const VIEWBOX_WIDTH = 1000;
const VIEWBOX_HEIGHT = 720;
const MIN_SCALE = 0.35;
const MAX_SCALE = 4.5;

type MapViewport = {
  scale: number;
  x: number;
  y: number;
};

type GraphDisplayMode = 'stars' | 'cards';

const filterOptions: Array<{ id: MemoryStarGraphFilter | 'all'; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'anchor', label: '锚点' },
  { id: 'warning', label: '可疑关系' },
  { id: 'conflict', label: '更新/冲突' },
  { id: 'boundary', label: '边界/约定' },
  { id: 'recent', label: '最近活跃' },
];

const relationLegend = [
  { color: '#A7B4C2', label: '相关' },
  { color: '#4D8FD9', label: '更新' },
  { color: '#D46A61', label: '冲突' },
  { color: '#65A66F', label: '支持' },
  { color: '#C9912F', label: '约定' },
  { color: '#E39A43', label: '可疑' },
  { color: '#D7BC72', label: '主题线' },
];

const domainLegend = [
  { color: '#8FC7E8', label: '相处' },
  { color: '#B9A7E8', label: '称呼' },
  { color: '#F4D77E', label: '喜好' },
  { color: '#F3A29A', label: '边界' },
  { color: '#9ED9B6', label: '经历' },
  { color: '#F0AFC7', label: '约定' },
  { color: '#8EDDE0', label: '日常' },
  { color: '#BBC5CC', label: '其他' },
];

function clamp(value: number, min: number, max: number) {
  'worklet';
  return Math.max(min, Math.min(max, value));
}

function truncateLabel(value: string, limit = 12) {
  const text = value.trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function relationDetail(edge: MemoryStarGraphEdge) {
  if (edge.kind === 'topic_link') return '主题线：把记忆连到主题入口，只用于帮助看懂聚类，不能修理。';
  const tags = edge.diagnostic?.tags.join('、') || '关系安静';
  return `${edge.label} · ${Math.round((edge.confidence ?? 0) * 100)}% · ${tags}`;
}

function nodeDetailText(node: MemoryStarGraphNode) {
  if (node.kind === 'topic') {
    return ['主题入口', node.subtitle ?? '若干相关记忆', '不是一条真实记忆'].join(' · ');
  }
  const memory = node.memory;
  const kind = memory?.anchor ? '长期坐标' : memory?.tags.includes('阶段记忆') ? '阶段记忆' : memory?.domain ?? '记忆';
  const importance = memory?.importance != null ? '重要度 ' + memory.importance : '重要度未知';
  return kind + ' · ' + importance;
}
function nodeCardSize(node: MemoryStarGraphNode) {
  if (node.kind === 'topic') {
    return { height: 46, width: Math.min(164, Math.max(118, node.label.length * 13 + 42)) };
  }
  return { height: node.label.length > 12 ? 58 : 50, width: Math.min(168, Math.max(124, node.label.length * 11 + 42)) };
}

function nodeCardColors(node: MemoryStarGraphNode, selected: boolean) {
  if (selected) return { backgroundColor: '#FFF8E8', borderColor: '#D29B35', textColor: '#1F2933' };
  if (node.kind === 'topic') return { backgroundColor: '#FFF5D7', borderColor: '#D8B54E', textColor: '#6F5520' };
  if (node.tags.includes('锚点')) return { backgroundColor: '#FFF4DF', borderColor: '#D8A744', textColor: '#3B3328' };
  if (node.tags.includes('阶段记忆')) return { backgroundColor: '#EEF6FF', borderColor: '#91BEE8', textColor: '#263C52' };
  if (node.muted) return { backgroundColor: '#F2F4F6', borderColor: '#C8D0D8', textColor: '#6B7480' };
  return { backgroundColor: '#FFFFFF', borderColor: '#D7E2EC', textColor: '#2F3A48' };
}

function starRadius(node: MemoryStarGraphNode) {
  if (node.kind === 'topic') return Math.max(15, Math.min(28, node.radius * 0.78));
  const importance = node.memory?.importance ?? 5;
  const base = node.tags.includes('锚点') ? 10.5 : 6.5 + importance * 0.55;
  return Math.max(7, Math.min(13.5, base));
}

function starHitRadius(node: MemoryStarGraphNode, currentScale: number) {
  if (node.kind === 'topic') return Math.max(18, starRadius(node));
  return Math.max(starRadius(node) + 8, 22 / Math.max(currentScale, 0.5));
}

function linePath(source: MemoryStarGraphNode, target: MemoryStarGraphNode) {
  return `M ${source.x} ${source.y} L ${target.x} ${target.y}`;
}

function arrowPath(source: MemoryStarGraphNode, target: MemoryStarGraphNode) {
  const angle = Math.atan2(target.y - source.y, target.x - source.x);
  const endX = target.x - Math.cos(angle) * (target.radius + 8);
  const endY = target.y - Math.sin(angle) * (target.radius + 8);
  const left = angle + Math.PI * 0.82;
  const right = angle - Math.PI * 0.82;
  const size = 13;
  return [
    `M ${endX} ${endY}`,
    `L ${endX + Math.cos(left) * size} ${endY + Math.sin(left) * size}`,
    `L ${endX + Math.cos(right) * size} ${endY + Math.sin(right) * size}`,
    'Z',
  ].join(' ');
}

function motionHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function nodeDrift(node: MemoryStarGraphNode, phase: number) {
  const seed = motionHash(node.id);
  const amp = node.kind === 'topic' ? 2 : node.tags.includes('锚点') ? 2.3 : 3.2;
  const speed = 0.34 + (seed % 11) * 0.018;
  const offset = (seed % 628) / 100;
  return {
    x: Math.sin(phase * speed + offset) * amp + Math.sin(phase * 0.21 + offset * 0.7) * amp * 0.35,
    y: Math.cos(phase * (speed * 0.82) + offset * 1.31) * amp * 0.78,
  };
}

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  if (!dx && !dy) return Math.hypot(px - ax, py - ay);
  const ratio = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + ratio * dx), py - (ay + ratio * dy));
}

function fitScaleForFrame(width: number, height: number) {
  if (!width || !height) return 0.82;
  return Math.max(MIN_SCALE, Math.min(1.05, Math.min(width / VIEWBOX_WIDTH, height / VIEWBOX_HEIGHT) * 0.92));
}

function clampMapTranslation(x: number, y: number, currentScale: number, frameWidth: number, frameHeight: number) {
  if (!frameWidth || !frameHeight) return { x: 0, y: 0 };
  const minVisibleX = Math.min(180, frameWidth * 0.45);
  const minVisibleY = Math.min(180, frameHeight * 0.45);
  const maxX = Math.max(0, (VIEWBOX_WIDTH * currentScale) / 2 + frameWidth / 2 - minVisibleX);
  const maxY = Math.max(0, (VIEWBOX_HEIGHT * currentScale) / 2 + frameHeight / 2 - minVisibleY);
  return {
    x: clamp(x, -maxX, maxX),
    y: clamp(y, -maxY, maxY),
  };
}

function screenToGraphPoint(
  locationX: number,
  locationY: number,
  currentScale: number,
  currentTranslateX: number,
  currentTranslateY: number,
  frameWidth: number,
  frameHeight: number,
) {
  return {
    x: VIEWBOX_WIDTH / 2 + (locationX - frameWidth / 2 - currentTranslateX) / currentScale,
    y: VIEWBOX_HEIGHT / 2 + (locationY - frameHeight / 2 - currentTranslateY) / currentScale,
  };
}

function viewBoxForViewport(viewport: MapViewport, frameWidth: number, frameHeight: number) {
  const safeWidth = Math.max(1, frameWidth);
  const safeHeight = Math.max(1, frameHeight);
  const width = safeWidth / viewport.scale;
  const height = safeHeight / viewport.scale;
  const left = VIEWBOX_WIDTH / 2 - width / 2 - viewport.x / viewport.scale;
  const top = VIEWBOX_HEIGHT / 2 - height / 2 - viewport.y / viewport.scale;
  return `${left} ${top} ${width} ${height}`;
}

function touchDistance(touches: Array<{ pageX: number; pageY: number }>) {
  if (touches.length < 2) return 0;
  const [left, right] = touches;
  return Math.hypot(left.pageX - right.pageX, left.pageY - right.pageY);
}

function touchCenter(touches: Array<{ locationX: number; locationY: number }>) {
  if (touches.length < 2) return { x: 0, y: 0 };
  const [left, right] = touches;
  return {
    x: (left.locationX + right.locationX) / 2,
    y: (left.locationY + right.locationY) / 2,
  };
}

export function MemoryStarMapView({
  graph,
  loading = false,
  modeLabel,
  onClose,
  onDeleteEdge,
  onFilterChange,
  onOpenMemory,
  onOpenTopic,
  onReverseEdge,
  onSearchChange,
  onSelectEdge,
  onSelectNode,
  onSoftenEdge,
  onToggleMode,
  query,
  selectedEdgeId,
  selectedFilters,
  selectedNodeId,
}: Props) {
  const insets = useSafeAreaInsets();
  const detailSheetSafeBottom = Math.max(insets.bottom, 34);
  const [frameSize, setFrameSize] = useState({ height: 0, width: 0 });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [detailExpanded, setDetailExpanded] = useState(false);
  const [displayMode, setDisplayMode] = useState<GraphDisplayMode>('stars');
  const [idlePhase, setIdlePhase] = useState(1.35);
  const [viewport, setViewport] = useState<MapViewport>({ scale: 0.82, x: 0, y: 0 });
  const viewportRef = useRef<MapViewport>({ scale: 0.82, x: 0, y: 0 });
  const displayNodesRef = useRef<Map<string, MemoryStarGraphNode>>(new Map());
  const gestureActiveRef = useRef(false);
  const queuedViewportRef = useRef<MapViewport | null>(null);
  const frameRequestRef = useRef<number | null>(null);
  const gestureRef = useRef({
    distance: 0,
    lastCenterX: 0,
    lastCenterY: 0,
    moved: false,
    scale: 1,
    startX: 0,
    startY: 0,
    wasPinching: false,
  });
  const nodesById = useMemo(() => new Map((graph?.nodes ?? []).map((node) => [node.id, node])), [graph]);
  const selectedNode = selectedNodeId ? nodesById.get(selectedNodeId) : undefined;
  const selectedEdge = selectedEdgeId ? graph?.edges.find((edge) => edge.id === selectedEdgeId) : undefined;
  const activeFilters = selectedFilters.length ? selectedFilters.map((filter) => filterOptions.find((item) => item.id === filter)?.label ?? filter).join('、') : '全部';
  const displayNodes = useMemo(() => {
    return new Map((graph?.nodes ?? []).map((node) => {
      const drift = nodeDrift(node, idlePhase);
      return [node.id, { ...node, x: node.x + drift.x, y: node.y + drift.y }];
    }));
  }, [graph, idlePhase]);
  displayNodesRef.current = displayNodes;

  useEffect(() => {
    setDetailExpanded(false);
  }, [selectedEdgeId, selectedNodeId]);

  useEffect(() => {
    const next = fitScaleForFrame(frameSize.width, frameSize.height);
    const nextViewport = { scale: next, x: 0, y: 0 };
    viewportRef.current = nextViewport;
    setViewport(nextViewport);
  }, [frameSize.height, frameSize.width, graph]);

  useEffect(() => () => {
    if (frameRequestRef.current !== null) cancelAnimationFrame(frameRequestRef.current);
  }, []);

  useEffect(() => {
    if (!graph?.nodes.length) return undefined;
    const timer = setInterval(() => {
      if (gestureActiveRef.current) return;
      setIdlePhase((phase) => (phase + 0.5) % 1000);
    }, 780);
    return () => clearInterval(timer);
  }, [graph]);

  const applyViewport = useCallback((nextViewport: MapViewport, commit = false) => {
    viewportRef.current = nextViewport;
    queuedViewportRef.current = nextViewport;
    if (commit) {
      if (frameRequestRef.current !== null) {
        cancelAnimationFrame(frameRequestRef.current);
        frameRequestRef.current = null;
      }
      setViewport(nextViewport);
      return;
    }
    if (frameRequestRef.current !== null) return;
    frameRequestRef.current = requestAnimationFrame(() => {
      frameRequestRef.current = null;
      if (queuedViewportRef.current) setViewport(queuedViewportRef.current);
    });
  }, []);

  const handleGraphTap = useCallback((graphX: number, graphY: number, currentScale: number) => {
    if (!graph) return;
    const currentNodes = displayNodesRef.current;
    const hitNode = [...Array.from(currentNodes.values())].reverse().find((node) => {
      if (displayMode === 'stars') {
        return Math.hypot(graphX - node.x, graphY - node.y) <= starHitRadius(node, currentScale);
      }
      const size = nodeCardSize(node);
      return graphX >= node.x - size.width / 2
        && graphX <= node.x + size.width / 2
        && graphY >= node.y - size.height / 2
        && graphY <= node.y + size.height / 2;
    });
    if (hitNode) {
      onSelectNode(hitNode.id);
      onSelectEdge(null);
      return;
    }
    const threshold = Math.max(10, 24 / Math.max(currentScale, 0.5));
    const hitEdge = graph.edges
      .filter((edge) => edge.kind === 'memory_edge')
      .map((edge) => {
        const source = currentNodes.get(edge.sourceId);
        const target = currentNodes.get(edge.targetId);
        if (!source || !target) return null;
        return { distance: distanceToSegment(graphX, graphY, source.x, source.y, target.x, target.y), edge };
      })
      .filter((item): item is { distance: number; edge: MemoryStarGraphEdge } => !!item)
      .sort((left, right) => left.distance - right.distance)[0];
    if (hitEdge && hitEdge.distance <= threshold) {
      onSelectEdge(hitEdge.edge.id);
      onSelectNode(null);
      return;
    }
    onSelectEdge(null);
    onSelectNode(null);
  }, [displayMode, graph, onSelectEdge, onSelectNode]);

  const resetView = () => {
    const next = fitScaleForFrame(frameSize.width, frameSize.height);
    const nextViewport = { scale: next, x: 0, y: 0 };
    applyViewport(nextViewport, true);
  };

  const toggleFilter = (filter: MemoryStarGraphFilter | 'all') => {
    if (filter === 'all') {
      onFilterChange([]);
      return;
    }
    const next = selectedFilters.includes(filter)
      ? selectedFilters.filter((item) => item !== filter)
      : [...selectedFilters, filter];
    onFilterChange(next);
  };

  const panResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (event, gesture) => event.nativeEvent.touches.length >= 2 || Math.abs(gesture.dx) > 4 || Math.abs(gesture.dy) > 4,
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: (event) => {
      gestureActiveRef.current = true;
      const touches = event.nativeEvent.touches as Array<{ locationX: number; locationY: number; pageX: number; pageY: number }>;
      const center = touchCenter(touches);
      gestureRef.current = {
        distance: touchDistance(touches),
        lastCenterX: center.x,
        lastCenterY: center.y,
        moved: false,
        scale: viewportRef.current.scale,
        startX: viewportRef.current.x,
        startY: viewportRef.current.y,
        wasPinching: touches.length >= 2,
      };
    },
    onPanResponderMove: (event, gesture) => {
      const touches = event.nativeEvent.touches as Array<{ locationX: number; locationY: number; pageX: number; pageY: number }>;
      gestureRef.current.moved = gestureRef.current.moved || Math.abs(gesture.dx) > 5 || Math.abs(gesture.dy) > 5 || touches.length >= 2;
      if (touches.length >= 2) {
        gestureRef.current.wasPinching = true;
        const currentDistance = touchDistance(touches);
        const center = touchCenter(touches);
        if (!gestureRef.current.distance) {
          gestureRef.current.distance = currentDistance;
          gestureRef.current.lastCenterX = center.x;
          gestureRef.current.lastCenterY = center.y;
          gestureRef.current.scale = viewportRef.current.scale;
          gestureRef.current.startX = viewportRef.current.x;
          gestureRef.current.startY = viewportRef.current.y;
          return;
        }
        const previousDistance = gestureRef.current.distance || currentDistance || 1;
        const currentViewport = viewportRef.current;
        const oldScale = currentViewport.scale;
        const nextScale = clamp(oldScale * (currentDistance / Math.max(previousDistance, 1)), MIN_SCALE, MAX_SCALE);
        const ratio = nextScale / Math.max(oldScale, 0.001);
        const focalX = center.x - frameSize.width / 2;
        const focalY = center.y - frameSize.height / 2;
        const panX = center.x - gestureRef.current.lastCenterX;
        const panY = center.y - gestureRef.current.lastCenterY;
        const next = clampMapTranslation(
          (currentViewport.x - focalX) * ratio + focalX + panX,
          (currentViewport.y - focalY) * ratio + focalY + panY,
          nextScale,
          frameSize.width,
          frameSize.height,
        );
        const nextViewport = { scale: nextScale, x: next.x, y: next.y };
        applyViewport(nextViewport);
        gestureRef.current.distance = currentDistance;
        gestureRef.current.lastCenterX = center.x;
        gestureRef.current.lastCenterY = center.y;
        return;
      }
      if (gestureRef.current.wasPinching) {
        return;
      }
      const next = clampMapTranslation(
        gestureRef.current.startX + gesture.dx,
        gestureRef.current.startY + gesture.dy,
        gestureRef.current.scale,
        frameSize.width,
        frameSize.height,
      );
      const nextViewport = { scale: gestureRef.current.scale, x: next.x, y: next.y };
      applyViewport(nextViewport);
    },
    onPanResponderRelease: (event, gesture) => {
      setViewport(viewportRef.current);
      gestureActiveRef.current = false;
      if (gestureRef.current.moved || Math.abs(gesture.dx) > 5 || Math.abs(gesture.dy) > 5) return;
      const currentViewport = viewportRef.current;
      const graphPoint = screenToGraphPoint(
        event.nativeEvent.locationX,
        event.nativeEvent.locationY,
        currentViewport.scale,
        currentViewport.x,
        currentViewport.y,
        frameSize.width,
        frameSize.height,
      );
      handleGraphTap(graphPoint.x, graphPoint.y, currentViewport.scale);
    },
    onPanResponderTerminate: () => {
      setViewport(viewportRef.current);
      gestureActiveRef.current = false;
    },
    onPanResponderTerminationRequest: () => false,
  }), [applyViewport, frameSize.height, frameSize.width, handleGraphTap]);
  const graphViewBox = viewBoxForViewport(viewport, frameSize.width, frameSize.height);
  const graphContent = useMemo(() => {
    if (!graph) return null;
    return (
      <>
        <G>
          {graph.edges.map((edge) => {
            const source = displayNodes.get(edge.sourceId);
            const target = displayNodes.get(edge.targetId);
            if (!source || !target) return null;
            const selected = selectedEdgeId === edge.id;
            const opacity = edge.kind === 'topic_link' ? 0.36 : edge.muted ? 0.18 : 0.42;
            return (
              <Fragment key={edge.id}>
                <Path
                  d={linePath(source, target)}
                  opacity={selected ? 1 : opacity}
                  stroke={edge.color}
                  strokeDasharray={edge.kind === 'topic_link' ? '6 7' : edge.muted ? '8 10' : undefined}
                  strokeLinecap="round"
                  strokeWidth={selected ? 6 : edge.kind === 'topic_link' ? 2.6 : 2.5}
                />
                {edge.kind === 'memory_edge' && selected ? (
                  <Path d={arrowPath(source, target)} fill={edge.color} opacity={0.95} />
                ) : null}
              </Fragment>
            );
          })}
        </G>
        <G>
          {graph.nodes.map((rawNode) => {
            const node = displayNodes.get(rawNode.id) ?? rawNode;
            const selected = selectedNodeId === node.id;
            if (displayMode === 'stars') {
              const radius = starRadius(node);
              const glowOpacity = node.muted ? 0.08 : node.kind === 'topic' ? 0.14 : 0.24;
              return (
                <G key={node.id}>
                  {node.kind === 'topic' ? (
                    <>
                      <Circle cx={node.x} cy={node.y} fill="#F4D77E" opacity={0.13} r={radius * 2.35} />
                      <Circle cx={node.x} cy={node.y} fill="#F4D77E" opacity={0.12} r={radius * 1.55} />
                      <Circle
                        cx={node.x}
                        cy={node.y}
                        fill="#FFF8D9"
                        opacity={0.36}
                        r={radius * 0.86}
                        stroke="#D8B54E"
                        strokeDasharray="3 5"
                        strokeWidth={1.5}
                      />
                      {selected ? <Circle cx={node.x} cy={node.y} fill="none" opacity={0.9} r={radius * 1.65} stroke="#D29B35" strokeWidth={2.6} /> : null}
                    </>
                  ) : (
                    <>
                      <Circle cx={node.x} cy={node.y} fill={node.color} opacity={glowOpacity} r={radius * 3.1} />
                      <Circle cx={node.x} cy={node.y} fill={node.color} opacity={node.muted ? 0.12 : 0.28} r={radius * 1.85} />
                      {node.tags.includes('锚点') ? (
                        <Circle cx={node.x} cy={node.y} fill="none" opacity={0.78} r={radius + 8} stroke="#F2D98C" strokeWidth={3} />
                      ) : null}
                      {node.memory?.pinned ? (
                        <Circle cx={node.x} cy={node.y} fill="none" opacity={0.72} r={radius + 4.5} stroke="#F6C873" strokeWidth={1.8} />
                      ) : null}
                      <Circle
                        cx={node.x}
                        cy={node.y}
                        fill={node.color}
                        opacity={node.muted ? 0.46 : 0.95}
                        r={radius}
                        stroke={node.color}
                        strokeOpacity={0.62}
                        strokeWidth={1.4}
                      />
                      {selected ? <Circle cx={node.x} cy={node.y} fill="none" opacity={0.95} r={radius + 12} stroke="#D29B35" strokeWidth={3.2} /> : null}
                    </>
                  )}
                </G>
              );
            }
            const size = nodeCardSize(node);
            const palette = nodeCardColors(node, selected);
            return (
              <G key={node.id}>
                <Rect
                  fill={palette.backgroundColor}
                  height={size.height}
                  opacity={node.muted ? 0.72 : 1}
                  rx={node.kind === 'topic' ? 16 : 10}
                  stroke={palette.borderColor}
                  strokeDasharray={node.kind === 'topic' ? '9 7' : undefined}
                  strokeWidth={selected ? 3 : 1.6}
                  width={size.width}
                  x={node.x - size.width / 2}
                  y={node.y - size.height / 2}
                />
                {selected ? (
                  <Circle cx={node.x + size.width / 2 - 10} cy={node.y - size.height / 2 + 10} fill="#D29B35" r={4} />
                ) : null}
                <SvgText
                  fill={palette.textColor}
                  fontSize={node.kind === 'topic' ? 14 : 13}
                  fontWeight="700"
                  textAnchor="middle"
                  x={node.x}
                  y={node.y - 4}
                >
                  {truncateLabel(node.label, node.kind === 'topic' ? 10 : 14)}
                </SvgText>
                <SvgText
                  fill="#7E93A7"
                  fontSize={10}
                  fontWeight="600"
                  textAnchor="middle"
                  x={node.x}
                  y={node.y + 16}
                >
                  {truncateLabel(node.kind === 'topic' ? node.subtitle ?? '主题' : node.subtitle ?? node.tags[0] ?? '记忆', 12)}
                </SvgText>
              </G>
            );
          })}
        </G>
      </>
    );
  }, [displayMode, displayNodes, graph, selectedEdgeId, selectedNodeId]);

  return (
    <View style={styles.container}>
      <View
        onLayout={(event) => {
          const next = {
            height: event.nativeEvent.layout.height,
            width: event.nativeEvent.layout.width,
          };
          setFrameSize((current) => (
            current.height === next.height && current.width === next.width ? current : next
          ));
        }}
        style={styles.mapFrame}
        {...panResponder.panHandlers}
      >
          {!graph || loading ? (
            <Text style={styles.emptyText}>正在整理星图...</Text>
          ) : graph.nodes.length === 0 ? (
            <Text style={styles.emptyText}>暂时没有可绘制的关系星图。</Text>
          ) : (
            <View style={styles.graphLayer}>
              <Svg height={Math.max(1, frameSize.height)} viewBox={graphViewBox} width={Math.max(1, frameSize.width)}>
                {graphContent}
              </Svg>
            </View>
          )}
      </View>

      <View pointerEvents="box-none" style={[styles.topLayer, { paddingTop: Math.max(insets.top, 18) + 10 }]}>
        <View style={styles.headerRow}>
          <Pressable onPress={onClose} style={styles.roundButton}>
            <Text style={styles.roundButtonText}>‹</Text>
          </Pressable>
          <View style={styles.headerTitleBox}>
            <Text style={styles.headerTitle}>关系星图</Text>
            <Text style={styles.headerSubtitle}>{modeLabel}</Text>
          </View>
          <Pressable onPress={onToggleMode} style={styles.modeButton}>
            <Text style={styles.modeButtonText}>{modeLabel === '局部' ? '概览' : '局部'}</Text>
          </Pressable>
          <Pressable onPress={() => setDisplayMode((value) => value === 'stars' ? 'cards' : 'stars')} style={styles.displayModeButton}>
            <Text style={styles.displayModeButtonText}>{displayMode === 'stars' ? '纸条' : '星点'}</Text>
          </Pressable>
        </View>
        <View style={styles.searchRow}>
          <TextInput
            onChangeText={onSearchChange}
            placeholder="搜索记忆、标签、主题..."
            placeholderTextColor={colors.muted}
            style={styles.searchInput}
            value={query}
          />
          <Pressable onPress={resetView} style={styles.resetButton}>
            <Text style={styles.resetText}>复位</Text>
          </Pressable>
        </View>
      </View>

      <View pointerEvents="box-none" style={[styles.legendWrap, { top: Math.max(insets.top, 18) + 122 }]}>
        <Pressable onPress={() => setFiltersOpen((value) => !value)} style={styles.legendToggle}>
          <Text style={styles.legendToggleText}>图例 · {activeFilters}</Text>
        </Pressable>
        {filtersOpen ? (
          <View style={styles.legendPanel}>
            {graph ? (
              <Text style={styles.legendSummary}>
                记忆 {graph.stats.memoryCount} · 主题 {graph.stats.topicCount} · 关系 {graph.stats.edgeCount} · 可疑 {graph.stats.warningCount}
              </Text>
            ) : null}
            <ScrollView horizontal contentContainerStyle={styles.filterRow} showsHorizontalScrollIndicator={false}>
              {filterOptions.map((filter) => {
                const active = filter.id === 'all' ? selectedFilters.length === 0 : selectedFilters.includes(filter.id);
                return (
                  <Pressable key={filter.id} onPress={() => toggleFilter(filter.id)} style={[styles.filterChip, active && styles.filterChipActive]}>
                    <Text style={[styles.filterText, active && styles.filterTextActive]}>{filter.label}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
            <View style={styles.legendLineRow}>
              {domainLegend.map((item) => (
                <View key={item.label} style={styles.legendItem}>
                  <View style={[styles.legendOrb, { backgroundColor: item.color }]} />
                  <Text style={styles.legendText}>{item.label}</Text>
                </View>
              ))}
            </View>
            <View style={styles.legendLineRow}>
              {relationLegend.map((item) => (
                <View key={item.label} style={styles.legendItem}>
                  <View style={[styles.legendDot, { backgroundColor: item.color }]} />
                  <Text style={styles.legendText}>{item.label}</Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}
      </View>

      {graph && !filtersOpen ? (
        <>
          <View pointerEvents="none" style={[styles.statsPill, { top: Math.max(insets.top, 18) + 174 }]}>
            <Text style={styles.statsText}>
              记忆 {graph.stats.memoryCount} · 主题 {graph.stats.topicCount} · 关系 {graph.stats.edgeCount} · 可疑 {graph.stats.warningCount}
            </Text>
          </View>
          <View pointerEvents="none" style={[styles.helpPill, { top: Math.max(insets.top, 18) + 212 }]}>
            <Text style={styles.helpText}>{modeLabel === '局部' ? '围绕当前记忆显示' : '概览精选显示，不是全部'} · 点记忆、主题入口或关系线</Text>
          </View>
        </>
      ) : null}

      <View
        style={[
          styles.detailSheet,
          detailExpanded && styles.detailSheetExpanded,
          {
            bottom: 0,
            maxHeight: (detailExpanded ? 320 : 124) + detailSheetSafeBottom,
            minHeight: (detailExpanded ? 236 : 82) + detailSheetSafeBottom,
            paddingBottom: detailSheetSafeBottom + 10,
          },
        ]}
      >
        <Pressable onPress={() => setDetailExpanded((value) => !value)} style={styles.sheetHandleArea}>
          <View style={styles.sheetHandle} />
          <Text style={styles.sheetHint}>{detailExpanded ? '收起详情' : selectedNode || selectedEdge ? '点这里展开详情' : '点节点或关系查看详情'}</Text>
        </Pressable>
        {selectedNode ? (
          <View style={styles.sheetContent}>
            <Text numberOfLines={detailExpanded ? 2 : 1} style={styles.detailTitle}>{selectedNode.label}</Text>
            <Text numberOfLines={1} style={styles.detailMeta}>{nodeDetailText(selectedNode)}</Text>
            <Text numberOfLines={detailExpanded ? 5 : 1} style={styles.detailText}>
              {selectedNode.kind === 'topic' ? '由记忆分类、标签、想起词和当前状态整理出来，用来查看相关记忆。主题入口只负责导航，不会改写正文。' : selectedNode.memory?.content}
            </Text>
            {detailExpanded ? (
              <>
                <View style={styles.tagRow}>
                  {selectedNode.tags.slice(0, 5).map((tag) => <Text key={tag} style={styles.tag}>{tag}</Text>)}
                </View>
                {selectedNode.memory ? (
                  <Pressable onPress={() => onOpenMemory(selectedNode.memory!)} style={styles.primaryButton}>
                    <Text style={styles.primaryButtonText}>打开这条记忆</Text>
                  </Pressable>
                ) : (
                  <View style={styles.actionRow}>
                    <Pressable
                      onPress={() => onOpenTopic?.(selectedNode.topicKey ?? selectedNode.id, selectedNode.label)}
                      style={styles.primaryButton}
                    >
                      <Text style={styles.primaryButtonText}>打开主题档案</Text>
                    </Pressable>
                    <Pressable onPress={() => onSearchChange(selectedNode.label)} style={styles.secondaryButton}>
                      <Text style={styles.secondaryButtonText}>只看这个主题</Text>
                    </Pressable>
                  </View>
                )}
              </>
            ) : null}
          </View>
        ) : selectedEdge ? (
          <View style={styles.sheetContent}>
            <Text style={styles.detailTitle}>{selectedEdge.label}</Text>
            <Text numberOfLines={detailExpanded ? 4 : 1} style={styles.detailText}>{relationDetail(selectedEdge)}</Text>
            {detailExpanded ? (
              <>
                {selectedEdge.edge?.reason ? <Text style={styles.detailText}>原因：{selectedEdge.edge.reason}</Text> : null}
                {selectedEdge.diagnostic?.note ? <Text style={styles.detailText}>{selectedEdge.diagnostic.note}</Text> : null}
                {selectedEdge.kind === 'memory_edge' && selectedEdge.edge ? (
                  <View style={styles.actionRow}>
                    <Pressable onPress={() => onReverseEdge(selectedEdge.edge!.id)} style={styles.secondaryButton}>
                      <Text style={styles.secondaryButtonText}>方向反了</Text>
                    </Pressable>
                    {selectedEdge.relationType !== 'relates_to' ? (
                      <Pressable onPress={() => onSoftenEdge(selectedEdge.edge!.id)} style={styles.secondaryButton}>
                        <Text style={styles.secondaryButtonText}>改为相关</Text>
                      </Pressable>
                    ) : null}
                    <Pressable onPress={() => onDeleteEdge(selectedEdge.edge!.id)} style={styles.deleteButton}>
                      <Text style={styles.deleteButtonText}>隐藏关系</Text>
                    </Pressable>
                  </View>
                ) : null}
              </>
            ) : null}
          </View>
        ) : (
          <Text style={styles.detailText}>
            {modeLabel === '局部'
              ? '局部会围绕当前记忆显示附近关系。拖动地图、双指缩放；点星点或小纸条查看记忆，点关系线修理关系。'
              : '概览只精选显示重要、活跃、锚点或关系密集的记忆，不是全部记忆。拖动地图、双指缩放；搜索可以缩小范围。'}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  container: { backgroundColor: '#F5FAFF', flex: 1 },
  deleteButton: { alignItems: 'center', backgroundColor: '#FFF0EA', borderColor: '#FFD8CD', borderRadius: 12, borderWidth: 1, justifyContent: 'center', minHeight: 38, paddingHorizontal: 12 },
  deleteButtonText: { color: '#C8796D', fontSize: 12, fontWeight: '700' },
  detailSheet: { backgroundColor: '#FFFFFF', borderBottomWidth: 0, borderColor: '#DDECF8', borderTopLeftRadius: 22, borderTopRightRadius: 22, borderWidth: 1, bottom: 0, left: 0, maxHeight: 124, minHeight: 82, paddingHorizontal: 16, paddingTop: 7, position: 'absolute', right: 0, shadowColor: '#2B3A4C', shadowOffset: { height: -5, width: 0 }, shadowOpacity: 0.12, shadowRadius: 14, elevation: 0 },
  detailSheetExpanded: { maxHeight: 320, minHeight: 236 },
  detailMeta: { color: '#5683A9', fontSize: 11, fontWeight: '700', lineHeight: 16 },
  detailText: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  detailTitle: { color: colors.ink, fontSize: 16, fontWeight: '800' },
  emptyText: { alignSelf: 'center', color: colors.muted, fontSize: 13, padding: 16, textAlign: 'center' },
  filterChip: { backgroundColor: '#FFF0EA', borderRadius: 14, height: 31, justifyContent: 'center', paddingHorizontal: 11 },
  filterChipActive: { backgroundColor: '#EE8D7D' },
  filterRow: { gap: 7, paddingRight: 4 },
  filterText: { color: '#A76F67', fontSize: 12, fontWeight: '700' },
  filterTextActive: { color: '#FFFFFF' },
  graphLayer: { ...StyleSheet.absoluteFillObject },
  headerRow: { alignItems: 'center', flexDirection: 'row', gap: 10, paddingHorizontal: 14 },
  headerSubtitle: { color: '#6B8398', fontSize: 11, fontWeight: '700', marginTop: 1 },
  headerTitle: { color: colors.ink, fontSize: 18, fontWeight: '800' },
  headerTitleBox: { backgroundColor: 'rgba(255,255,255,0.9)', borderColor: '#DDECF8', borderRadius: 16, borderWidth: 1, flex: 1, paddingHorizontal: 12, paddingVertical: 8 },
  helpPill: { alignSelf: 'flex-start', backgroundColor: 'rgba(255,255,255,0.74)', borderColor: 'rgba(221,236,248,0.82)', borderRadius: 13, borderWidth: 1, left: 14, paddingHorizontal: 10, paddingVertical: 6, position: 'absolute' },
  helpText: { color: '#7891A8', fontSize: 10.5, fontWeight: '500' },
  legendDot: { borderRadius: 4, height: 8, width: 18 },
  legendItem: { alignItems: 'center', flexDirection: 'row', gap: 5 },
  legendLineRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 9 },
  legendOrb: { borderColor: 'rgba(255,255,255,0.85)', borderRadius: 6, borderWidth: 1, height: 12, shadowColor: '#9FB7C9', shadowOpacity: 0.18, shadowRadius: 3, width: 12 },
  legendPanel: { backgroundColor: 'rgba(255,255,255,0.96)', borderColor: '#DDECF8', borderRadius: 16, borderWidth: 1, marginTop: 8, maxWidth: 350, padding: 10, shadowColor: '#8CA7BD', shadowOpacity: 0.12, shadowRadius: 10, elevation: 8 },
  legendSummary: { color: '#5683A9', fontSize: 11, fontWeight: '600', marginBottom: 8 },
  legendText: { color: '#5E7891', fontSize: 11, fontWeight: '600' },
  legendToggle: { alignSelf: 'flex-start', backgroundColor: 'rgba(255,255,255,0.94)', borderColor: '#DDECF8', borderRadius: 15, borderWidth: 1, paddingHorizontal: 11, paddingVertical: 8 },
  legendToggleText: { color: '#5683A9', fontSize: 12, fontWeight: '600' },
  legendWrap: { left: 14, position: 'absolute', right: 14 },
  mapFrame: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  modeButton: { alignItems: 'center', backgroundColor: '#FFE3DB', borderRadius: 18, height: 42, justifyContent: 'center', minWidth: 54, paddingHorizontal: 12 },
  modeButtonText: { color: '#D87767', fontSize: 13, fontWeight: '800' },
  displayModeButton: { alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.95)', borderColor: '#DDECF8', borderRadius: 18, borderWidth: 1, height: 42, justifyContent: 'center', minWidth: 54, paddingHorizontal: 12 },
  displayModeButtonText: { color: '#5683A9', fontSize: 13, fontWeight: '700' },
  primaryButton: { alignItems: 'center', alignSelf: 'flex-start', backgroundColor: '#EE8D7D', borderRadius: 12, justifyContent: 'center', minHeight: 38, paddingHorizontal: 12 },
  primaryButtonText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
  resetButton: { alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.95)', borderColor: '#DDECF8', borderRadius: 13, borderWidth: 1, height: 42, justifyContent: 'center', paddingHorizontal: 13 },
  resetText: { color: '#5683A9', fontSize: 12, fontWeight: '700' },
  roundButton: { alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.95)', borderColor: '#DDECF8', borderRadius: 21, borderWidth: 1, height: 42, justifyContent: 'center', width: 42 },
  roundButtonText: { color: colors.ink, fontSize: 30, lineHeight: 33 },
  searchInput: { backgroundColor: 'rgba(255,255,255,0.96)', borderColor: '#FFE0D7', borderRadius: 15, borderWidth: 1, color: colors.ink, flex: 1, fontSize: 14, minHeight: 43, paddingHorizontal: 12, paddingVertical: 10 },
  searchRow: { flexDirection: 'row', gap: 8, marginTop: 9, paddingHorizontal: 14 },
  secondaryButton: { alignItems: 'center', backgroundColor: '#F7FBFF', borderColor: '#DDECF8', borderRadius: 12, borderWidth: 1, justifyContent: 'center', minHeight: 38, paddingHorizontal: 12 },
  secondaryButtonText: { color: '#5683A9', fontSize: 12, fontWeight: '700' },
  sheetContent: { gap: 7 },
  sheetHandle: { alignSelf: 'center', backgroundColor: '#C8D6E4', borderRadius: 2, height: 4, marginBottom: 4, width: 42 },
  sheetHandleArea: { alignItems: 'center', paddingBottom: 6 },
  sheetHint: { color: '#7891A8', fontSize: 11, fontWeight: '700' },
  statsPill: { alignSelf: 'flex-start', backgroundColor: 'rgba(255,255,255,0.9)', borderColor: '#DDECF8', borderRadius: 14, borderWidth: 1, left: 14, paddingHorizontal: 10, paddingVertical: 7, position: 'absolute' },
  statsText: { color: '#5683A9', fontSize: 11, fontWeight: '600' },
  tag: { backgroundColor: '#EAF4FF', borderRadius: 10, color: '#5783AA', fontSize: 11, paddingHorizontal: 8, paddingVertical: 4 },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  topLayer: { left: 0, position: 'absolute', right: 0, top: 0 },
});
