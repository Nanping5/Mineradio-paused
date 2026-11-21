import React, { useEffect, useState } from 'react';
import { desktopWindow } from '../bridge/tauriBridge';
import { visualEngine } from '../engines';
import { usePlayerStore } from '../store/playerStore';
import {
  DEFAULT_FX_SETTINGS,
  VISUAL_PRESETS,
  type CacheSettings,
  type FxSettings,
  type HotkeyBinding,
  type MemorySnapshot,
  type WallpaperEngineProject,
} from '../types/mineradio';

export interface FxConsoleModalProps {
  onToast?: (message: string) => void;
}

type FxTabKey = 'home' | 'interface' | 'lyrics' | 'motion' | 'shelf' | 'system';

const FX_TABS: Array<{ key: FxTabKey; label: string }> = [
  { key: 'home', label: '常用' },
  { key: 'interface', label: '界面' },
  { key: 'lyrics', label: '歌词' },
  { key: 'motion', label: '动效' },
  { key: 'shelf', label: '歌单架' },
  { key: 'system', label: '系统' },
];

const LYRIC_FONTS = [
  { value: 'sans', label: '默认' },
  { value: 'hei', label: '黑体' },
  { value: 'song', label: '宋体' },
  { value: 'kai-song', label: '楷宋' },
  { value: 'serif-en', label: 'Serif' },
  { value: 'gothic', label: 'Gothic' },
  { value: 'mono', label: '等宽' },
  { value: 'display', label: '标题' },
];

const FAST_SKIP_LS_KEY = 'mineradio-startup-fast-skip-v1';

function formatBytes(bytes?: number): string {
  if (!bytes || !Number.isFinite(bytes)) return '—';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(1)} MB`;
}

export interface WeRootEntry {
  id?: string;
  rootId?: string;
  name?: string;
  path?: string;
}

export function extractWeRoots(weRes: Record<string, unknown> | null | undefined): WeRootEntry[] {
  if (!weRes || typeof weRes !== 'object') return [];
  const list = Array.isArray(weRes.manualRoots)
    ? weRes.manualRoots
    : Array.isArray(weRes.roots)
    ? weRes.roots
    : [];
  return list as WeRootEntry[];
}

export function resolveWeProjectMediaType(
  project: { mediaType?: unknown; type?: unknown; file?: unknown },
  mediaUrl: string
): 'video' | 'image' {
  const declared = String(project.mediaType || '').trim().toLowerCase();
  if (declared === 'video' || declared === 'image') {
    return declared;
  }
  const candidates: string[] = [];
  if (mediaUrl) {
    candidates.push(mediaUrl);
    try {
      const qIdx = mediaUrl.indexOf('?');
      if (qIdx >= 0) {
        const params = new URLSearchParams(mediaUrl.slice(qIdx + 1));
        const innerPath = params.get('path');
        if (innerPath) {
          candidates.push(decodeURIComponent(innerPath));
        }
      }
      candidates.push(decodeURIComponent(mediaUrl));
    } catch {
      // ignore malformed uri encoding
    }
  }
  if (project.file) candidates.push(String(project.file));
  if (candidates.some((c) => /\.(mp4|webm|mov|m4v)(\?|$)/i.test(c))) {
    return 'video';
  }
  if (String(project.type || '').trim().toLowerCase() === 'video') {
    return 'video';
  }
  return 'image';
}

export function normalizeCloseBehaviorUi(raw: unknown): 'tray' | 'exit' {
  const s = String(raw || '').trim().toLowerCase();
  return s === 'exit' || s === 'quit' ? 'exit' : 'tray';
}

export function FxConsoleModal({ onToast }: FxConsoleModalProps): React.ReactElement {
  const fx = usePlayerStore((s) => s.fx);
  const activePreset = usePlayerStore((s) => s.activePreset);
  const fxPanelOpen = usePlayerStore((s) => s.fxPanelOpen);
  const shelfOpen = usePlayerStore((s) => s.shelfOpen);
  const desktopLyricsEnabled = usePlayerStore((s) => s.desktopLyricsEnabled);
  const desktopLyricsLocked = usePlayerStore((s) => s.desktopLyricsLocked);

  const setFxPanelOpen = usePlayerStore((s) => s.setFxPanelOpen);
  const updateFx = usePlayerStore((s) => s.updateFx);
  const resetFxDefaults = usePlayerStore((s) => s.resetFxDefaults);
  const applyVisualPreset = usePlayerStore((s) => s.applyVisualPreset);
  const setShelfOpen = usePlayerStore((s) => s.setShelfOpen);
  const toggleDesktopLyrics = usePlayerStore((s) => s.toggleDesktopLyrics);
  const setCustomLyricModalOpen = usePlayerStore((s) => s.setCustomLyricModalOpen);
  const setActiveBackgroundMedia = usePlayerStore((s) => s.setActiveBackgroundMedia);
  const fxArchiveSlots = usePlayerStore((s) => s.fxArchiveSlots);
  const applyFxArchiveSlot = usePlayerStore((s) => s.applyFxArchiveSlot);
  const hotkeyBindings = usePlayerStore((s) => s.hotkeyBindings);
  const updateHotkeyBindings = usePlayerStore((s) => s.updateHotkeyBindings);
  const gestureEnabled = usePlayerStore((s) => s.gestureEnabled);
  const gestureStatus = usePlayerStore((s) => s.gestureStatus);
  const setGestureEnabled = usePlayerStore((s) => s.setGestureEnabled);
  const [freeCameraOn, setFreeCameraOn] = useState<boolean>(() => {
    try {
      return Boolean(visualEngine.isFreeCameraActive?.());
    } catch {
      return false;
    }
  });

  const [activeTab, setActiveTab] = useState<FxTabKey>('home');
  const [searchTerm, setSearchTerm] = useState('');
  const [cacheSettings, setCacheSettings] = useState<CacheSettings | null>(null);
  const [memorySnapshot, setMemorySnapshot] = useState<MemorySnapshot | null>(null);
  const [weProjects, setWeProjects] = useState<WallpaperEngineProject[]>([]);
  const [weRoots, setWeRoots] = useState<WeRootEntry[]>([]);
  const [weLoading, setWeLoading] = useState(false);
  const [activeWeId, setActiveWeId] = useState<string>('');
  const [closeBehavior, setCloseBehavior] = useState<'tray' | 'exit'>('tray');
  const [fastSkip, setFastSkip] = useState<boolean>(() => {
    try {
      return window.localStorage?.getItem(FAST_SKIP_LS_KEY) === '1';
    } catch {
      return false;
    }
  });

  const refreshSystemDiagnostics = async () => {
    const [cacheRes, memRes, closeRes, weRes] = await Promise.all([
      desktopWindow.getCacheSettings().catch(() => null),
      desktopWindow.getMemorySnapshot().catch(() => null),
      desktopWindow.getCloseBehavior().catch(() => ({ behavior: 'tray' })),
      desktopWindow.listWallpaperEngineProjects().catch(() => ({
        ok: false,
        projects: [] as WallpaperEngineProject[],
        manualRoots: [] as WeRootEntry[],
      })),
    ]);
    if (cacheRes) setCacheSettings(cacheRes);
    if (memRes) setMemorySnapshot(memRes);
    setCloseBehavior(normalizeCloseBehaviorUi(closeRes?.behavior));
    setWeProjects(weRes?.projects || []);
    setWeRoots(extractWeRoots(weRes as unknown as Record<string, unknown>));
  };

  useEffect(() => {
    if (fxPanelOpen && activeTab === 'system') {
      refreshSystemDiagnostics().catch(() => {});
    }
  }, [fxPanelOpen, activeTab]);

  const handleExportJson = async () => {
    const res = await desktopWindow.exportJsonFile({
      filename: `mineradio-fx-preset-${fx.preset}.json`,
      title: '导出视觉参数存档',
      data: fx,
    });
    if (res.ok) {
      onToast?.(`已导出配置：${res.path || 'JSON'}`);
    }
  };

  const handleImportJson = async () => {
    const res = await desktopWindow.importJsonFile();
    if (res.canceled) return;
    if (!res.ok || !res.data || typeof res.data !== 'object') {
      onToast?.(res.error || '导入的 JSON 文件无效');
      return;
    }
    const imported = res.data as Partial<FxSettings>;
    updateFx(imported);
    onToast?.('已导入并应用视觉参数存档');
  };

  const handleChooseCacheDir = async () => {
    const res = await desktopWindow.chooseCacheDirectory();
    if (res.ok && res.path) {
      const updated = await desktopWindow.setCacheSettings({
        cacheRoot: res.path,
        rootPath: res.path,
      });
      const fresh = await desktopWindow.getCacheSettings().catch(() => null);
      setCacheSettings(fresh || updated);
      onToast?.(`缓存目录已切换为：${res.path}`);
    }
  };

  const handleTrimMemory = async () => {
    const res = await desktopWindow.trimAppMemory({ reason: 'manual' });
    const snap = await desktopWindow.getMemorySnapshot().catch(() => null);
    if (snap) setMemorySnapshot(snap);
    onToast?.(res.supported === false ? '当前环境不支持进程工作集压缩' : '已执行播放器内存裁剪');
  };

  const handlePurgeSystemMemory = async () => {
    const res = await desktopWindow.purgeSystemMemory({ mask: fx.memorySystemMask });
    const snap = await desktopWindow.getMemorySnapshot().catch(() => null);
    if (snap) setMemorySnapshot(snap);
    onToast?.(res.supported === false ? '当前平台不支持系统级内存释放' : '已触发系统内存释放');
  };

  const handleAddWeDir = async () => {
    setWeLoading(true);
    try {
      const res = await desktopWindow.chooseWallpaperEngineDirectory();
      if (res.ok && res.path) {
        const list = await desktopWindow.listWallpaperEngineProjects();
        setWeProjects(list.projects || []);
        setWeRoots(extractWeRoots(list as unknown as Record<string, unknown>));
        onToast?.('已添加 Wallpaper Engine 目录');
      }
    } finally {
      setWeLoading(false);
    }
  };

  const handleStartWeProject = async (project: WallpaperEngineProject) => {
    const res = await desktopWindow.startWallpaperEngineScene({
      id: project.id,
      file: project.file,
      type: project.type,
    });
    if (res.ok !== false) {
      const mediaUrl = String(project.mediaUrl || project.previewUrl || '');
      if (mediaUrl) {
        setActiveBackgroundMedia({
          type: resolveWeProjectMediaType(project, mediaUrl),
          url: mediaUrl,
          muted: true,
          source: 'wallpaper-engine',
          projectId: project.id,
        });
      }
      setActiveWeId(project.id);
      onToast?.(`已启用壁纸场景：${project.title}`);
    } else {
      onToast?.('当前环境无法启动 Wallpaper Engine 场景');
    }
  };

  const handleStopWeProject = async () => {
    await desktopWindow.stopWallpaperEngineScene();
    setActiveBackgroundMedia(null);
    setActiveWeId('');
    onToast?.('已恢复默认背景');
  };

  const handleRemoveWeRoot = async (rootId: string) => {
    await desktopWindow.removeWallpaperEngineDirectory(rootId);
    const list = await desktopWindow.listWallpaperEngineProjects();
    setWeProjects(list.projects || []);
    setWeRoots(extractWeRoots(list as unknown as Record<string, unknown>));
    onToast?.('已移除 Wallpaper Engine 目录');
  };

  const handleCloseBehaviorChange = async (behavior: 'tray' | 'exit') => {
    const res = await desktopWindow.setCloseBehavior(behavior);
    setCloseBehavior(normalizeCloseBehaviorUi(res.behavior));
    onToast?.(behavior === 'exit' ? '关闭按钮行为：直接退出' : '关闭按钮行为：最小化到托盘');
  };

  const [quitArmed, setQuitArmed] = useState(false);
  useEffect(() => {
    if (!quitArmed) return undefined;
    const timer = window.setTimeout(() => setQuitArmed(false), 4000);
    return () => window.clearTimeout(timer);
  }, [quitArmed]);

  const handleQuitApp = async () => {
    if (!quitArmed) {
      setQuitArmed(true);
      onToast?.('再次点击以确认彻底退出 MineradioX');
      return;
    }
    setQuitArmed(false);
    onToast?.('正在退出 MineradioX…');
    await desktopWindow.close('quit');
  };

  const toggleFastSkip = () => {
    const next = !fastSkip;
    setFastSkip(next);
    try {
      window.localStorage?.setItem(FAST_SKIP_LS_KEY, next ? '1' : '0');
    } catch {
      // ignore
    }
    onToast?.(next ? '已开启秒启动跳过启动页' : '已关闭秒启动跳过启动页');
  };

  const q = searchTerm.trim().toLowerCase();
  const hit = (label: string) => !q || label.toLowerCase().includes(q);

  const numSlider = (
    field: keyof FxSettings,
    label: string,
    min: number,
    max: number,
    step: number,
    digits = 2
  ) => {
    if (!hit(label)) return null;
    const raw = fx[field];
    const value = typeof raw === 'number' ? raw : Number(DEFAULT_FX_SETTINGS[field]) || 0;
    return (
      <div className="fx-slider" key={String(field)}>
        <label htmlFor={`fx-${String(field)}`}>{label}</label>
        <input
          id={`fx-${String(field)}`}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => updateFx({ [field]: Number(e.target.value) } as Partial<FxSettings>)}
        />
        <output>{value.toFixed(digits)}</output>
      </div>
    );
  };

  const boolToggle = (field: keyof FxSettings, label: string) => {
    if (!hit(label)) return null;
    const active = Boolean(fx[field]);
    return (
      <button
        key={String(field)}
        type="button"
        id={`fx-toggle-${String(field)}`}
        className={`fx-toggle${active ? ' on' : ''}`}
        onClick={() => updateFx({ [field]: !active } as Partial<FxSettings>)}
      >
        <span>{label}</span>
        <span className="dot" />
      </button>
    );
  };

  const colorRow = (
    field: keyof FxSettings,
    label: string,
    fallback: string,
    modePatch?: Partial<FxSettings>
  ) => {
    if (!hit(label)) return null;
    const val = String(fx[field] || fallback);
    return (
      <div className="lyric-color-row" key={String(field)}>
        <input
          id={`fx-${String(field)}`}
          className="lyric-color-picker"
          type="color"
          value={/^#[0-9a-f]{6}$/i.test(val) ? val : fallback}
          title={label}
          onChange={(e) =>
            updateFx({
              ...(modePatch || {}),
              [field]: e.target.value,
            } as Partial<FxSettings>)
          }
        />
        <div className="fx-color-row-label">
          {label}
          <small>{val.toUpperCase()}</small>
        </div>
      </div>
    );
  };

  const segRow = (
    field: keyof FxSettings,
    label: string,
    options: Array<{ key: string; label: string }>
  ) => {
    if (!hit(label)) return null;
    return (
      <div key={String(field)} style={{ marginTop: 6 }}>
        <div className="fx-sub">{label}</div>
        <div className="fx-seg" id={`fx-seg-${String(field)}`}>
          {options.map((o) => (
            <button
              key={o.key}
              type="button"
              className={fx[field] === o.key ? 'active' : undefined}
              onClick={() => updateFx({ [field]: o.key } as Partial<FxSettings>)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
    );
  };

  const weQuery = q;
  const visibleWeProjects = weQuery
    ? weProjects.filter(
        (p) =>
          String(p.title || '').toLowerCase().includes(weQuery) ||
          String(p.type || '').toLowerCase().includes(weQuery) ||
          String(p.id || '').toLowerCase().includes(weQuery)
      )
    : weProjects;

  const patchHotkey = (id: string, patch: Partial<HotkeyBinding>) => {
    updateHotkeyBindings(
      hotkeyBindings.map((b) => (b.id === id ? { ...b, ...patch } : b))
    ).catch(() => {});
  };

  const handleToggleFreeCamera = () => {
    try {
      setFreeCameraOn(Boolean(visualEngine.toggleFreeCamera()));
    } catch {
      setFreeCameraOn((v) => !v);
    }
  };

  const handleToggleGesture = () => {
    setGestureEnabled(!gestureEnabled).catch(() => {});
  };

  const isPreset7 = activePreset === 7 || fx.preset === 7;
  const isPreset8 = activePreset === 8 || fx.preset === 8;
  const cacheDetail = cacheSettings?.settings;
  const cacheUsage = cacheSettings?.usage;
  const cacheRootText =
    cacheDetail?.rootPath || cacheSettings?.effectiveRoot || cacheSettings?.cacheRoot || '默认应用数据目录';
  const memTotalMB =
    memorySnapshot?.totalMB ??
    (memorySnapshot?.totalBytes ?? memorySnapshot?.systemTotalBytes
      ? (memorySnapshot?.totalBytes ?? memorySnapshot?.systemTotalBytes ?? 0) / 1048576
      : undefined);
  const memUsedMB =
    memorySnapshot?.usedMB ??
    (memorySnapshot?.usedBytes ? memorySnapshot.usedBytes / 1048576 : undefined);
  const memUsedPercent = memorySnapshot?.usedPercent ?? memorySnapshot?.systemUsedPercent;
  const procMB =
    memorySnapshot?.process?.rssMB ??
    memorySnapshot?.process?.privateMB ??
    (memorySnapshot?.workingSetBytes ? memorySnapshot.workingSetBytes / 1048576 : undefined);
  const fmtMB = (mb?: number) =>
    mb == null || !Number.isFinite(mb) ? '—' : mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
  const filteredPresets = q
    ? VISUAL_PRESETS.filter(
        (p) => p.name.toLowerCase().includes(q) || p.desc.toLowerCase().includes(q)
      )
    : VISUAL_PRESETS;

  return (
    <>
      <button
        id="fx-fab"
        className={fxPanelOpen ? 'active' : undefined}
        type="button"
        title="视觉控制台"
        aria-label="视觉控制台"
        aria-expanded={fxPanelOpen}
        onClick={() => setFxPanelOpen(!fxPanelOpen)}
      >
        <svg width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.9" viewBox="0 0 24 24">
          <path d="M4 7h8" />
          <path d="M16 7h4" />
          <circle cx="14" cy="7" r="2" />
          <path d="M4 17h4" />
          <path d="M12 17h8" />
          <circle cx="10" cy="17" r="2" />
        </svg>
      </button>

      <div id="fx-panel" className={fxPanelOpen ? 'show' : undefined} aria-hidden={!fxPanelOpen}>
        <div className="fx-head">
          <div>
            <div className="fx-title">视觉控制台</div>
            <div className="fx-sub">MINERADIOX VISUALS · 6 大任务工作台</div>
          </div>
          <button
            type="button"
            className="fx-mini-btn ghost"
            aria-label="关闭视觉控制台"
            onClick={() => setFxPanelOpen(false)}
          >
            ×
          </button>
        </div>

        <div className="fx-console-toolbar">
          <div className="fx-console-search-row">
            <span className="fx-console-search-icon" aria-hidden="true">
              ⌕
            </span>
            <input
              type="search"
              className="fx-console-search"
              placeholder="搜索预设或参数..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            <button
              type="button"
              className="fx-console-tool-btn"
              onClick={() => {
                handleExportJson().catch(() => {});
              }}
              title="导出 JSON 存档"
            >
              导出
            </button>
            <button
              type="button"
              className="fx-console-tool-btn"
              onClick={() => {
                handleImportJson().catch(() => {});
              }}
              title="导入 JSON 存档"
            >
              导入
            </button>
          </div>

          <div className="fx-panel-tabs" role="tablist" aria-label="视觉控制台页签">
            {FX_TABS.map((tab) => {
              const active = activeTab === tab.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={active ? 'active' : undefined}
                  onClick={() => setActiveTab(tab.key)}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* 1. 常用 */}
        {activeTab === 'home' && (
          <div className="fx-console-group open">
            <div className="fx-section-label">视觉预设 (0 - 12)</div>
            <div className="preset-grid" id="preset-grid">
              {filteredPresets.map((preset) => {
                const isActive = activePreset === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    data-preset={preset.id}
                    className={`preset-card${isActive ? ' active' : ''}${
                      preset.premiumVisual ? ' preset-card-premium' : ''
                    }`}
                    style={
                      preset.accent
                        ? ({
                            '--preset-accent': preset.accent,
                            '--preset-accent-2': preset.accent2 || preset.accent,
                          } as React.CSSProperties)
                        : undefined
                    }
                    onClick={() => {
                      applyVisualPreset(preset.id);
                      onToast?.(`已切换视觉预设：${preset.name}`);
                    }}
                  >
                    <span className="pc-icon">{preset.id}</span>
                    <div className="pc-name">{preset.name}</div>
                    <div className="pc-desc">{preset.desc}</div>
                  </button>
                );
              })}
            </div>

            <div className="fx-section-label">常用快捷控制</div>
            <div className="fx-slider">
              <label htmlFor="fx-home-intensity">律动强度</label>
              <input
                id="fx-home-intensity"
                type="range"
                min="0.2"
                max="1.6"
                step="0.01"
                value={fx.intensity}
                onChange={(e) => updateFx({ intensity: Number(e.target.value) })}
              />
              <output>{fx.intensity.toFixed(2)}</output>
            </div>
            <div className="fx-slider">
              <label htmlFor="fx-home-lyricscale">歌词大小</label>
              <input
                id="fx-home-lyricscale"
                type="range"
                min="0.35"
                max="1.65"
                step="0.01"
                value={fx.lyricScale}
                onChange={(e) => updateFx({ lyricScale: Number(e.target.value) })}
              />
              <output>{fx.lyricScale.toFixed(2)}</output>
            </div>

            <div className="fx-toggle-grid">
              <button
                type="button"
                className={`fx-toggle${fx.particleLyrics ? ' on' : ''}`}
                onClick={() => updateFx({ particleLyrics: !fx.particleLyrics })}
              >
                <span>舞台歌词</span>
                <span className="dot" />
              </button>
              <button
                type="button"
                className={`fx-toggle${desktopLyricsEnabled ? ' on' : ''}`}
                onClick={() => {
                  toggleDesktopLyrics().catch(() => {});
                }}
              >
                <span>桌面歌词</span>
                <span className="dot" />
              </button>
            </div>

            {fxArchiveSlots.length > 0 && (
              <>
                <div className="fx-section-label">存档槽位 · 一键套用</div>
                <div id="fx-archive-slots" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {fxArchiveSlots
                    .filter((slot) => hit(slot.label || slot.name))
                    .map((slot) => (
                      <button
                        key={slot.name}
                        type="button"
                        className="fx-mini-btn ghost"
                        data-fx-archive-slot={slot.name}
                        onClick={() => {
                          applyFxArchiveSlot(slot.name);
                          onToast?.(`已套用存档：${slot.label || slot.name}`);
                        }}
                      >
                        {slot.label || slot.name}
                      </button>
                    ))}
                </div>
              </>
            )}

            <div className="fx-section-label">存档与重置</div>
            <div className="fx-actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                className="fx-mini-btn ghost"
                type="button"
                onClick={() => {
                  handleExportJson().catch(() => {});
                }}
              >
                导出 JSON 存档
              </button>
              <button
                className="fx-mini-btn ghost"
                type="button"
                onClick={() => {
                  handleImportJson().catch(() => {});
                }}
              >
                导入 JSON 存档
              </button>
              <button
                className="fx-mini-btn"
                type="button"
                onClick={() => {
                  resetFxDefaults();
                  onToast?.('已恢复全部默认视觉参数');
                }}
              >
                恢复默认
              </button>
            </div>
          </div>
        )}

        {/* 2. 界面 */}
        {activeTab === 'interface' && (
          <div className="fx-console-group open">
            <div className="fx-section-label">自定义颜色</div>
            <div className="lyric-color-row">
              <input
                id="ui-accent-picker"
                className="lyric-color-picker"
                type="color"
                value={fx.uiAccentColor || '#ffffff'}
                title="界面高亮色"
                onChange={(e) => updateFx({ uiAccentColor: e.target.value })}
              />
              <div className="fx-color-row-label">
                界面高亮<small id="ui-accent-value">{(fx.uiAccentColor || '#ffffff').toUpperCase()}</small>
              </div>
              <button
                className="fx-mini-btn ghost"
                type="button"
                onClick={() => updateFx({ uiAccentColor: DEFAULT_FX_SETTINGS.uiAccentColor })}
              >
                默认
              </button>
            </div>

            <div className="lyric-color-row visual-tint-row">
              <input
                id="visual-tint-picker"
                className="lyric-color-picker"
                type="color"
                value={fx.visualTintColor || '#9db8cf'}
                title="视觉主色"
                onChange={(e) => updateFx({ visualTintMode: 'custom', visualTintColor: e.target.value })}
              />
              <div className="fx-color-row-label">
                视觉主色
                <small id="visual-tint-value">
                  {fx.visualTintMode === 'auto' ? '封面取色' : (fx.visualTintColor || '#9db8cf').toUpperCase()}
                </small>
              </div>
              <button
                className="fx-mini-btn ghost"
                type="button"
                onClick={() => updateFx({ visualTintMode: 'auto', visualTintColor: DEFAULT_FX_SETTINGS.visualTintColor })}
              >
                封面
              </button>
            </div>

            <div className="lyric-color-row">
              <input
                id="home-accent-picker"
                className="lyric-color-picker"
                type="color"
                value={fx.homeAccentColor || '#ffffff'}
                title="Home 填充色"
                onChange={(e) => updateFx({ homeAccentColor: e.target.value })}
              />
              <div className="fx-color-row-label">
                Home 填充<small>{(fx.homeAccentColor || '#ffffff').toUpperCase()}</small>
              </div>
              <button
                className="fx-mini-btn ghost"
                type="button"
                onClick={() => updateFx({ homeAccentColor: DEFAULT_FX_SETTINGS.homeAccentColor })}
              >
                默认
              </button>
            </div>

            <div className="lyric-color-row">
              <input
                id="bg-color-picker"
                className="lyric-color-picker"
                type="color"
                value={fx.backgroundColor || '#000000'}
                title="背景颜色"
                onChange={(e) => updateFx({ backgroundColorMode: 'custom', backgroundColor: e.target.value })}
              />
              <div className="fx-color-row-label">
                背景颜色
                <small>
                  {fx.backgroundColorMode === 'cover' ? '封面取色' : (fx.backgroundColor || '#000000').toUpperCase()}
                </small>
              </div>
              <button
                className="fx-mini-btn ghost"
                type="button"
                onClick={() => updateFx({ backgroundColorMode: 'cover', backgroundColor: '#000000' })}
              >
                封面
              </button>
            </div>

            <div className="fx-section-label">玻璃与左栏质感</div>
            <div className="fx-slider">
              <label>背景透明度</label>
              <input
                id="fx-bgopacity"
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={fx.backgroundOpacity}
                onChange={(e) => updateFx({ backgroundOpacity: Number(e.target.value) })}
              />
              <output>{fx.backgroundOpacity.toFixed(2)}</output>
            </div>
            <div className="fx-slider">
              <label>窗口背景透明</label>
              <input
                id="fx-windowbgopacity"
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={fx.windowBackgroundOpacity}
                onChange={(e) => updateFx({ windowBackgroundOpacity: Number(e.target.value) })}
              />
              <output>{fx.windowBackgroundOpacity.toFixed(2)}</output>
            </div>
            <div className="fx-slider">
              <label>毛玻璃透明</label>
              <input
                id="fx-bgglassopacity"
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={fx.backgroundGlassOpacity}
                onChange={(e) => updateFx({ backgroundGlassOpacity: Number(e.target.value) })}
              />
              <output>{fx.backgroundGlassOpacity.toFixed(2)}</output>
            </div>
            <div className="fx-slider">
              <label>左栏雾面</label>
              <input
                id="fx-playlistblur"
                type="range"
                min="14"
                max="60"
                step="1"
                value={fx.playlistPanelGlassBlur}
                onChange={(e) => updateFx({ playlistPanelGlassBlur: Number(e.target.value) })}
              />
              <output>{fx.playlistPanelGlassBlur}px</output>
            </div>
          </div>
        )}

        {/* 3. 歌词 */}
        {activeTab === 'lyrics' && (
          <div className="fx-console-group open">
            <div className="fx-section-label">歌词颜色与光效</div>
            <div className="lyric-color-row">
              <input
                id="lyric-color-picker"
                className="lyric-color-picker"
                type="color"
                value={fx.lyricColor || '#7ec8d8'}
                title="歌词主色"
                onChange={(e) => updateFx({ lyricColorMode: 'custom', lyricColor: e.target.value })}
              />
              <div className="fx-color-row-label">
                歌词主色
                <small>{fx.lyricColorMode === 'auto' ? '封面取色' : (fx.lyricColor || '#7ec8d8').toUpperCase()}</small>
              </div>
              <button
                className="fx-mini-btn ghost"
                type="button"
                onClick={() => updateFx({ lyricColorMode: 'auto' })}
              >
                封面
              </button>
            </div>

            <div className="lyric-color-row">
              <input
                id="lyric-highlight-picker"
                className="lyric-color-picker"
                type="color"
                value={fx.lyricHighlightColor || '#fff0b8'}
                title="歌词高亮色"
                onChange={(e) =>
                  updateFx({ lyricHighlightMode: 'custom', lyricHighlightColor: e.target.value })
                }
              />
              <div className="fx-color-row-label">
                高亮颜色
                <small>
                  {fx.lyricHighlightMode === 'auto'
                    ? '跟随歌词'
                    : (fx.lyricHighlightColor || '#fff0b8').toUpperCase()}
                </small>
              </div>
              <button
                className="fx-mini-btn ghost"
                type="button"
                onClick={() => updateFx({ lyricHighlightMode: 'auto' })}
              >
                跟随
              </button>
            </div>

            <div className="lyric-color-row">
              <input
                id="lyric-glow-picker"
                className="lyric-color-picker"
                type="color"
                value={fx.lyricGlowColor || '#9db8cf'}
                title="歌词辉光色"
                onChange={(e) => updateFx({ lyricGlowLinked: false, lyricGlowColor: e.target.value })}
              />
              <div className="fx-color-row-label">
                辉光颜色
                <small>
                  {fx.lyricGlowLinked ? '跟随高亮' : (fx.lyricGlowColor || '#9db8cf').toUpperCase()}
                </small>
              </div>
              <button
                className={`fx-mini-btn ghost${fx.lyricGlowLinked ? ' active' : ''}`}
                type="button"
                onClick={() => updateFx({ lyricGlowLinked: !fx.lyricGlowLinked })}
              >
                链接
              </button>
            </div>

            <div className="fx-section-label">显示模式与翻译</div>
            <div className="fx-seg" id="lyric-display-mode-seg">
              {[
                { key: 'single', label: '单行' },
                { key: 'multi', label: '多行' },
                { key: 'cinema', label: '沉浸' },
                { key: 'custom', label: '自定' },
              ].map((m) => (
                <button
                  key={m.key}
                  type="button"
                  className={fx.lyricDisplayMode === m.key ? 'active' : undefined}
                  onClick={() => updateFx({ lyricDisplayMode: m.key })}
                >
                  {m.label}
                </button>
              ))}
            </div>

            <div className="fx-seg" id="lyric-translation-mode-seg" style={{ marginTop: 8 }}>
              {[
                { key: 'off', label: '关闭译文' },
                { key: 'translation', label: '翻译' },
                { key: 'roma', label: '音译' },
                { key: 'multi', label: '多行' },
              ].map((m) => (
                <button
                  key={m.key}
                  type="button"
                  className={fx.lyricTranslationMode === m.key ? 'active' : undefined}
                  onClick={() => updateFx({ lyricTranslationMode: m.key })}
                >
                  {m.label}
                </button>
              ))}
            </div>

            <div className="fx-section-label">字体与排版</div>
            <div className="fx-font-grid expanded" id="lyric-font-grid">
              {LYRIC_FONTS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  className={fx.lyricFont === f.value ? 'active' : undefined}
                  onClick={() => updateFx({ lyricFont: f.value })}
                >
                  {f.label}
                </button>
              ))}
            </div>

            <div className="fx-slider">
              <label>歌词大小</label>
              <input
                id="fx-lyricscale"
                type="range"
                min="0.35"
                max="1.65"
                step="0.01"
                value={fx.lyricScale}
                onChange={(e) => updateFx({ lyricScale: Number(e.target.value) })}
              />
              <output>{fx.lyricScale.toFixed(2)}</output>
            </div>
            <div className="fx-slider">
              <label>字间距</label>
              <input
                id="fx-lyricspacing"
                type="range"
                min="-0.04"
                max="0.18"
                step="0.005"
                value={fx.lyricLetterSpacing}
                onChange={(e) => updateFx({ lyricLetterSpacing: Number(e.target.value) })}
              />
              <output>{fx.lyricLetterSpacing.toFixed(3)}</output>
            </div>
            <div className="fx-slider">
              <label>行距</label>
              <input
                id="fx-lyriclineheight"
                type="range"
                min="0.72"
                max="1.80"
                step="0.01"
                value={fx.lyricLineHeight}
                onChange={(e) => updateFx({ lyricLineHeight: Number(e.target.value) })}
              />
              <output>{fx.lyricLineHeight.toFixed(2)}</output>
            </div>
            <div className="fx-slider">
              <label>字重</label>
              <input
                id="fx-lyricweight"
                type="range"
                min="500"
                max="900"
                step="50"
                value={fx.lyricWeight}
                onChange={(e) => updateFx({ lyricWeight: Number(e.target.value) })}
              />
              <output>{fx.lyricWeight}</output>
            </div>
            {numSlider('lyricTextureClarity', '歌词纹理清晰度', 0.5, 2, 0.05)}
            <div className="fx-section-label">歌词故障效果</div>
            {boolToggle('lyricGlitchCameraBind', '故障绑定镜头')}
            {numSlider('lyricGlitchIntensity', '故障强度', 0, 2, 0.01)}
            {numSlider('lyricGlitchSlice', '故障切片', 0, 2, 0.01)}
            {numSlider('lyricGlitchChroma', '故障色散', 0, 2, 0.01)}
            {numSlider('lyricGlitchRate', '故障频率', 0, 2, 0.01)}
            {numSlider('lyricGlitchJitter', '故障抖动', 0, 2, 0.01)}
            <div className="fx-actions" style={{ marginTop: 8 }}>
              <button
                id="fx-custom-lyric-btn"
                type="button"
                className="fx-mini-btn"
                onClick={() => setCustomLyricModalOpen(true)}
              >
                自定义编辑歌词
              </button>
            </div>
            <div className="fx-slider">
              <label>垂直位置</label>
              <input
                id="fx-lyricy"
                type="range"
                min="-2.4"
                max="2.7"
                step="0.01"
                value={fx.lyricOffsetY}
                onChange={(e) => updateFx({ lyricOffsetY: Number(e.target.value) })}
              />
              <output>{fx.lyricOffsetY.toFixed(2)}</output>
            </div>

            <div className="fx-section-label">桌面歌词设置</div>
            <div className="fx-toggle-grid">
              <button
                type="button"
                className={`fx-toggle${desktopLyricsEnabled ? ' on' : ''}`}
                onClick={() => {
                  toggleDesktopLyrics().catch(() => {});
                }}
              >
                <span>开启桌面歌词</span>
                <span className="dot" />
              </button>
              <button
                type="button"
                className={`fx-toggle${desktopLyricsLocked ? ' on' : ''}`}
                onClick={() => {
                  desktopWindow.setDesktopLyricsLockState(!desktopLyricsLocked).catch(() => {});
                  updateFx({ desktopLyricsClickThrough: !desktopLyricsLocked });
                }}
              >
                <span>锁定穿透</span>
                <span className="dot" />
              </button>
            </div>
            <div className="fx-slider">
              <label>桌面歌词大小</label>
              <input
                id="fx-desktoplyricssize"
                type="range"
                min="0.72"
                max="1.55"
                step="0.01"
                value={fx.desktopLyricsSize}
                onChange={(e) => updateFx({ desktopLyricsSize: Number(e.target.value) })}
              />
              <output>{fx.desktopLyricsSize.toFixed(2)}</output>
            </div>
            <div className="fx-slider">
              <label>桌面歌词透明</label>
              <input
                id="fx-desktoplyricsopacity"
                type="range"
                min="0.28"
                max="1"
                step="0.01"
                value={fx.desktopLyricsOpacity}
                onChange={(e) => updateFx({ desktopLyricsOpacity: Number(e.target.value) })}
              />
              <output>{fx.desktopLyricsOpacity.toFixed(2)}</output>
            </div>
            {numSlider('desktopLyricsY', '桌面歌词纵向位置', 0, 1, 0.01)}
            {boolToggle('desktopLyricsCinema', '桌面歌词沉浸')}
            {boolToggle('desktopLyricsHighlight', '桌面歌词高亮')}
            {numSlider('desktopLyricsFps', '桌面歌词帧率', 15, 120, 1, 0)}
          </div>
        )}

        {/* 4. 动效 */}
        {activeTab === 'motion' && (
          <div className="fx-console-group open">
            <div className="fx-section-label">粒子与运镜主控</div>
            <div className="fx-slider">
              <label>律动强度</label>
              <input
                id="fx-intensity"
                type="range"
                min="0.2"
                max="1.6"
                step="0.01"
                value={fx.intensity}
                onChange={(e) => updateFx({ intensity: Number(e.target.value) })}
              />
              <output>{fx.intensity.toFixed(2)}</output>
            </div>
            <div className="fx-slider">
              <label>立体景深</label>
              <input
                id="fx-depth"
                type="range"
                min="0.2"
                max="1.8"
                step="0.01"
                value={fx.depth}
                onChange={(e) => updateFx({ depth: Number(e.target.value) })}
              />
              <output>{fx.depth.toFixed(2)}</output>
            </div>
            <div className="fx-slider">
              <label>封面清晰度</label>
              <input
                id="fx-coverres"
                type="range"
                min="0.75"
                max="1.55"
                step="0.01"
                value={fx.coverResolution}
                onChange={(e) => updateFx({ coverResolution: Number(e.target.value) })}
              />
              <output>{fx.coverResolution.toFixed(2)}</output>
            </div>
            <div className="fx-slider">
              <label>镜头晃动</label>
              <input
                id="fx-cineshake"
                type="range"
                min="0"
                max="1.8"
                step="0.01"
                value={fx.cinemaShake}
                onChange={(e) => updateFx({ cinemaShake: Number(e.target.value) })}
              />
              <output>{fx.cinemaShake.toFixed(2)}</output>
            </div>
            <div className="fx-slider">
              <label>粒子尺寸</label>
              <input
                id="fx-point"
                type="range"
                min="0.5"
                max="2.2"
                step="0.01"
                value={fx.point}
                onChange={(e) => updateFx({ point: Number(e.target.value) })}
              />
              <output>{fx.point.toFixed(2)}</output>
            </div>
            <div className="fx-slider">
              <label>粒子流速</label>
              <input
                id="fx-speed"
                type="range"
                min="0.2"
                max="2.5"
                step="0.01"
                value={fx.speed}
                onChange={(e) => updateFx({ speed: Number(e.target.value) })}
              />
              <output>{fx.speed.toFixed(2)}</output>
            </div>
            <div className="fx-slider">
              <label>色彩张力</label>
              <input
                id="fx-color"
                type="range"
                min="0.5"
                max="2.0"
                step="0.01"
                value={fx.color}
                onChange={(e) => updateFx({ color: Number(e.target.value) })}
              />
              <output>{fx.color.toFixed(2)}</output>
            </div>
            <div className="fx-slider">
              <label>溢光强度</label>
              <input
                id="fx-bloom"
                type="range"
                min="0"
                max="1.6"
                step="0.01"
                value={fx.bloomStrength}
                onChange={(e) => updateFx({ bloomStrength: Number(e.target.value) })}
              />
              <output>{fx.bloomStrength.toFixed(2)}</output>
            </div>
            <div className="fx-slider">
              <label>离散感</label>
              <input
                id="fx-scatter"
                type="range"
                min="0"
                max="0.5"
                step="0.01"
                value={fx.scatter}
                onChange={(e) => updateFx({ scatter: Number(e.target.value) })}
              />
              <output>{fx.scatter.toFixed(2)}</output>
            </div>

            {isPreset7 && (
              <div id="fx-preset-7-panel">
                <div className="fx-section-label">Preset 7 · Sonic Ground</div>
                {numSlider('sonicGroundAmplitude', '地形振幅', 0, 100, 1, 0)}
                {numSlider('sonicGroundMotionSpeed', '地形流速', 0, 100, 1, 0)}
                {numSlider('sonicGroundDensity', '地形密度', 0, 100, 1, 0)}
                {numSlider('sonicGroundRange', '地形范围', 0, 100, 1, 0)}
                {numSlider('sonicGroundLower', '歌词避让', 0, 100, 1, 0)}
                {numSlider('sonicGroundDepth', '地形纵深', 0, 100, 1, 0)}
                {numSlider('sonicGroundAutoRotate', '自动旋转', 0, 100, 1, 0)}
                {numSlider('sonicGroundGlow', '地形辉光', 0, 100, 1, 0)}
                {segRow('sonicGroundColorMode', '地形配色', [
                  { key: 'cover', label: '封面' },
                  { key: 'auto', label: '自动' },
                  { key: 'custom', label: '自定义' },
                ])}
                {colorRow('sonicGroundBaseColor', '底色', '#05070c', { sonicGroundColorMode: 'custom' })}
                {colorRow('sonicGroundCoolColor', '冷色', '#0066ff', { sonicGroundColorMode: 'custom' })}
                {colorRow('sonicGroundWarmColor', '暖色', '#ff3c19', { sonicGroundColorMode: 'custom' })}
                {colorRow('sonicGroundAccentColor', '强调色', '#33e6ff', { sonicGroundColorMode: 'custom' })}
                <div className="fx-section-label">频段增益</div>
                {numSlider('sonicGroundSubBass', 'Sub Bass', 0, 100, 1, 0)}
                {numSlider('sonicGroundBass', 'Bass', 0, 100, 1, 0)}
                {numSlider('sonicGroundLowMid', 'Low Mid', 0, 100, 1, 0)}
                {numSlider('sonicGroundMid', 'Mid', 0, 100, 1, 0)}
                {numSlider('sonicGroundHighMid', 'High Mid', 0, 100, 1, 0)}
                {numSlider('sonicGroundPresence', 'Presence', 0, 100, 1, 0)}
                {numSlider('sonicGroundBrilliance', 'Brilliance', 0, 100, 1, 0)}
                {numSlider('sonicGroundAir', 'Air', 0, 100, 1, 0)}
                <div className="fx-section-label">浮游粒子</div>
                <div className="fx-toggle-grid">{boolToggle('sonicGroundFloatingEnabled', '启用浮游粒子')}</div>
                {numSlider('sonicGroundFloatingIntensity', '浮游强度', 0, 100, 1, 0)}
                {numSlider('sonicGroundFloatingMinSize', '浮游最小尺寸', 0, 100, 1, 0)}
                {numSlider('sonicGroundFloatingMaxSize', '浮游最大尺寸', 0, 100, 1, 0)}
                {numSlider('sonicGroundFloatingSpeed', '浮游速度', 0, 100, 1, 0)}
                {numSlider('sonicGroundFloatingCount', '浮游数量', 0, 100, 1, 0)}
                <div className="fx-section-label">音频监听</div>
                <div className="fx-toggle-grid">
                  {boolToggle('sonicAudioMonitorEnabled', '音频监听')}
                  {boolToggle('sonicAudioAutoTrack', '自动跟踪')}
                </div>
                {numSlider('sonicAudioSensitivity', '监听灵敏度', 0, 100, 1, 0)}
                {numSlider('sonicAudioBandStart', '频段起点', 0, 510, 1, 0)}
                {numSlider('sonicAudioBandEnd', '频段终点', 2, 512, 1, 0)}
                {numSlider('sonicAudioThreshold', '触发阈值', 0, 100, 1, 0)}
                {numSlider('sonicAudioPulseStrength', '脉冲强度', 0, 100, 1, 0)}
              </div>
            )}

            {isPreset8 && (
              <div id="fx-preset-8-panel">
                <div className="fx-section-label">Preset 8 · Sonic Workshop</div>
                {numSlider('sonicWorkshopInputGain', '输入压制', 40, 100, 1, 0)}
                {numSlider('sonicWorkshopAudioIntensity', '音频强度', 0.3, 2.5, 0.01)}
                {numSlider('sonicWorkshopResponseRange', '响应范围', 0.3, 2, 0.01)}
                {numSlider('sonicWorkshopPeakIntensity', '峰值强度', 0, 1.4, 0.01)}
                {segRow('sonicWorkshopColorMode', '配色模式', [
                  { key: 'theme', label: '主题' },
                  { key: 'cover', label: '封面' },
                  { key: 'custom', label: '自定义' },
                ])}
                {colorRow('sonicWorkshopCustomColor', '自定义主色', '#d9dde3', {
                  sonicWorkshopColorMode: 'custom',
                })}
                {colorRow('sonicWorkshopBaseColor', '基础色', '#0b0c0e', {
                  sonicWorkshopColorMode: 'custom',
                  sonicWorkshopBaseColorMode: 'custom',
                })}
                {colorRow('sonicWorkshopWarmColor', '暖色', '#d9dde3', {
                  sonicWorkshopColorMode: 'custom',
                  sonicWorkshopWarmColorMode: 'custom',
                })}
                {colorRow('sonicWorkshopCoolColor', '冷色', '#ffffff', {
                  sonicWorkshopColorMode: 'custom',
                  sonicWorkshopCoolColorMode: 'custom',
                })}
                {colorRow('sonicWorkshopRippleColor', '涟漪色', '#ffffff', {
                  sonicWorkshopColorMode: 'custom',
                  sonicWorkshopRippleColorMode: 'custom',
                })}
                {colorRow('sonicWorkshopPeakColor', '峰值色', '#f2f5f8', {
                  sonicWorkshopColorMode: 'custom',
                  sonicWorkshopPeakColorMode: 'custom',
                })}
              </div>
            )}

            <div className="fx-section-label">视角与封面</div>
            <div className="fx-toggle-grid">
              {boolToggle('backCover', '封面背面')}
              <button
                id="fx-free-camera-btn"
                type="button"
                className={`fx-toggle${freeCameraOn ? ' on' : ''}`}
                onClick={handleToggleFreeCamera}
              >
                <span>自由相机</span>
                <span className="dot" />
              </button>
            </div>

            <div className="fx-section-label">叠加效果开关</div>
            <div className="fx-toggle-grid">
              {[
                { key: 'cinema', label: '电影镜头' },
                { key: 'bloom', label: '粒子溢光' },
                { key: 'edge', label: '轮廓高亮' },
                { key: 'floatLayer', label: '浮空粒子层' },
                { key: 'backgroundStarRiver', label: '背景星河' },
                { key: 'lyricGlow', label: '歌词溢光' },
              ].map((item) => {
                const active = Boolean(fx[item.key as keyof FxSettings]);
                return (
                  <button
                    key={item.key}
                    type="button"
                    className={`fx-toggle${active ? ' on' : ''}`}
                    onClick={() => updateFx({ [item.key]: !active } as Partial<FxSettings>)}
                  >
                    <span>{item.label}</span>
                    <span className="dot" />
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* 5. 歌单架 */}
        {activeTab === 'shelf' && (
          <div className="fx-console-group open">
            <div className="fx-section-label">3D 歌单架模式</div>
            <div className="fx-seg" id="shelf-seg">
              {[
                { key: 'off', label: '关闭' },
                { key: 'side', label: '侧栏' },
                { key: 'stage', label: '舞台' },
              ].map((mode) => (
                <button
                  key={mode.key}
                  type="button"
                  className={fx.shelf === mode.key ? 'active' : undefined}
                  onClick={() => {
                    updateFx({ shelf: mode.key });
                    setShelfOpen(mode.key !== 'off');
                  }}
                >
                  {mode.label}
                </button>
              ))}
            </div>

            <div className="fx-toggle-grid" style={{ marginTop: 10 }}>
              <button
                type="button"
                className={`fx-toggle${shelfOpen ? ' on' : ''}`}
                onClick={() => setShelfOpen(!shelfOpen)}
              >
                <span>展开 3D 歌单架</span>
                <span className="dot" />
              </button>
              <button
                type="button"
                className={`fx-toggle${fx.shelfShowPodcasts ? ' on' : ''}`}
                onClick={() => updateFx({ shelfShowPodcasts: !fx.shelfShowPodcasts })}
              >
                <span>显示播客歌单</span>
                <span className="dot" />
              </button>
            </div>

            <div className="fx-section-label">歌单架空间布局</div>
            <div className="fx-slider">
              <label>歌单架大小</label>
              <input
                id="fx-shelfsize"
                type="range"
                min="0.65"
                max="1.45"
                step="0.01"
                value={fx.shelfSize}
                onChange={(e) => updateFx({ shelfSize: Number(e.target.value) })}
              />
              <output>{fx.shelfSize.toFixed(2)}</output>
            </div>
            <div className="fx-slider">
              <label>左右位置</label>
              <input
                id="fx-shelfx"
                type="range"
                min="-1.2"
                max="1.2"
                step="0.01"
                value={fx.shelfOffsetX}
                onChange={(e) => updateFx({ shelfOffsetX: Number(e.target.value) })}
              />
              <output>{fx.shelfOffsetX.toFixed(2)}</output>
            </div>
            <div className="fx-slider">
              <label>上下位置</label>
              <input
                id="fx-shelfy"
                type="range"
                min="-0.9"
                max="0.9"
                step="0.01"
                value={fx.shelfOffsetY}
                onChange={(e) => updateFx({ shelfOffsetY: Number(e.target.value) })}
              />
              <output>{fx.shelfOffsetY.toFixed(2)}</output>
            </div>
            <div className="fx-slider">
              <label>侧向角度</label>
              <input
                id="fx-shelfangle"
                type="range"
                min="-30"
                max="30"
                step="1"
                value={fx.shelfAngleY}
                onChange={(e) => updateFx({ shelfAngleY: Number(e.target.value) })}
              />
              <output>{fx.shelfAngleY}°</output>
            </div>
            <div className="fx-slider">
              <label>整体透明度</label>
              <input
                id="fx-shelfopacity"
                type="range"
                min="0.25"
                max="1"
                step="0.01"
                value={fx.shelfOpacity}
                onChange={(e) => updateFx({ shelfOpacity: Number(e.target.value) })}
              />
              <output>{fx.shelfOpacity.toFixed(2)}</output>
            </div>
          </div>
        )}

        {/* 6. 系统 */}
        {activeTab === 'system' && (
          <div className="fx-console-group open">
            <div className="fx-section-label">关闭窗口行为</div>
            <div className="fx-seg" id="close-behavior-seg">
              <button
                type="button"
                className={closeBehavior === 'exit' ? 'active' : undefined}
                onClick={() => {
                  handleCloseBehaviorChange('exit').catch(() => {});
                }}
              >
                直接退出
              </button>
              <button
                type="button"
                className={closeBehavior === 'tray' ? 'active' : undefined}
                onClick={() => {
                  handleCloseBehaviorChange('tray').catch(() => {});
                }}
              >
                最小化到托盘
              </button>
            </div>

            <div className="fx-section-label">退出应用</div>
            <div
              className="fx-actions"
              id="quit-app-actions"
              style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
            >
              <button
                id="quit-app-btn"
                className="fx-mini-btn"
                type="button"
                onClick={() => {
                  handleQuitApp().catch(() => {});
                }}
              >
                {quitArmed ? '再次点击确认退出应用' : '退出应用（彻底结束进程）'}
              </button>
            </div>
            <div className="fx-sub">
              托盘菜单无法弹出、或窗口已隐藏到托盘时，可在此彻底结束进程；也可把「关闭窗口行为」改为「直接退出」。
            </div>

            <div className="fx-section-label">启动与渲染性能</div>
            <div className="fx-toggle-grid">
              <button
                type="button"
                className={`fx-toggle${fastSkip ? ' on' : ''}`}
                onClick={toggleFastSkip}
              >
                <span>秒启动跳过启动页</span>
                <span className="dot" />
              </button>
              <button
                type="button"
                className={`fx-toggle${fx.liveBackgroundKeep ? ' on' : ''}`}
                onClick={() => updateFx({ liveBackgroundKeep: !fx.liveBackgroundKeep })}
              >
                <span>后台保持渲染</span>
                <span className="dot" />
              </button>
            </div>

            <div className="fx-seg" id="performance-quality-seg" style={{ marginTop: 8 }}>
              {[
                { key: 'eco', label: '低画质' },
                { key: 'balanced', label: '均衡' },
                { key: 'high', label: '高画质' },
                { key: 'ultra', label: '超高' },
              ].map((qOpt) => (
                <button
                  key={qOpt.key}
                  type="button"
                  className={fx.performanceQuality === qOpt.key ? 'active' : undefined}
                  onClick={() => updateFx({ performanceQuality: qOpt.key })}
                >
                  {qOpt.label}
                </button>
              ))}
            </div>

            <div className="fx-section-label">手势控制</div>
            <div className="fx-toggle-grid">
              <button
                id="fx-gesture-toggle"
                type="button"
                className={`fx-toggle${gestureEnabled ? ' on' : ''}`}
                onClick={handleToggleGesture}
              >
                <span>手势控制 · {gestureStatus}</span>
                <span className="dot" />
              </button>
            </div>

            <div className="fx-section-label">全局快捷键</div>
            <div id="fx-hotkey-panel" style={{ display: 'grid', gap: 6 }}>
              {hotkeyBindings
                .filter((b) => hit(b.label) || hit(b.accelerator))
                .map((b) => (
                  <div
                    key={b.id}
                    className="hotkey-row"
                    style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}
                  >
                    <input
                      type="checkbox"
                      aria-label={`启用 ${b.label}`}
                      checked={b.enabled}
                      onChange={(e) => patchHotkey(b.id, { enabled: e.target.checked })}
                    />
                    <span style={{ flex: 1 }}>{b.label}</span>
                    <input
                      type="text"
                      className="fx-console-search"
                      style={{ width: 120 }}
                      aria-label={`${b.label} 快捷键`}
                      defaultValue={b.accelerator}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v && v !== b.accelerator) patchHotkey(b.id, { accelerator: v });
                      }}
                    />
                  </div>
                ))}
            </div>

            <div className="fx-section-label">内存快照与手动裁剪</div>
            <div className="cache-storage-panel">
              <div className="cache-storage-row">
                <span>系统内存总量</span>
                <b id="mem-total">{fmtMB(memTotalMB)}</b>
              </div>
              <div className="cache-storage-row">
                <span>系统已用</span>
                <b id="mem-used">{fmtMB(memUsedMB)}</b>
              </div>
              <div className="cache-storage-row">
                <span>系统内存占用</span>
                <b id="mem-percent">
                  {memUsedPercent != null && Number.isFinite(memUsedPercent)
                    ? `${memUsedPercent.toFixed(1)}%`
                    : memorySnapshot?.platform || '—'}
                </b>
              </div>
              <div className="cache-storage-row">
                <span>进程内存</span>
                <b id="mem-process">{fmtMB(procMB)}</b>
              </div>
              <div className="cache-storage-row">
                <span>私有提交</span>
                <b>
                  {memorySnapshot?.process?.privateMB != null
                    ? fmtMB(memorySnapshot.process.privateMB)
                    : formatBytes(memorySnapshot?.privateBytes)}
                </b>
              </div>
              <div className="memory-action-row" style={{ marginTop: 8 }}>
                <button
                  className="fx-mini-btn ghost"
                  type="button"
                  onClick={() => {
                    handleTrimMemory().catch(() => {});
                  }}
                >
                  手动裁剪内存
                </button>
                <button
                  className="fx-mini-btn ghost"
                  type="button"
                  onClick={() => {
                    handlePurgeSystemMemory().catch(() => {});
                  }}
                >
                  系统级释放
                </button>
              </div>
            </div>

            <div className="fx-section-label">缓存目录设置</div>
            <div className="cache-storage-panel">
              <div className="cache-storage-head">
                <span>统一缓存目录</span>
                <span>{cacheSettings?.cDriveProtected ? 'C盘保护' : '已就绪'}</span>
              </div>
              <code className="cache-storage-path" id="cache-storage-root">
                {cacheRootText}
              </code>
              {cacheUsage && (
                <div id="cache-usage" className="cache-storage-usage">
                  <div className="cache-storage-row">
                    <span>歌词缓存</span>
                    <b>{formatBytes(cacheUsage.lyricsBytes)}</b>
                  </div>
                  <div className="cache-storage-row">
                    <span>节拍缓存</span>
                    <b>{formatBytes(cacheUsage.beatmapsBytes)}</b>
                  </div>
                  <div className="cache-storage-row">
                    <span>Wallpaper Engine</span>
                    <b>{formatBytes(cacheUsage.wallpaperEngineBytes)}</b>
                  </div>
                  <div className="cache-storage-row">
                    <span>用户数据</span>
                    <b>{formatBytes(cacheUsage.userDataBytes)}</b>
                  </div>
                  <div className="cache-storage-row">
                    <span>托管合计</span>
                    <b id="cache-usage-total">{formatBytes(cacheUsage.totalManagedBytes)}</b>
                  </div>
                </div>
              )}
              <div className="cache-storage-actions">
                <button
                  className="fx-mini-btn ghost"
                  type="button"
                  onClick={() => {
                    handleChooseCacheDir().catch(() => {});
                  }}
                >
                  选择目录
                </button>
                <button
                  className="fx-mini-btn ghost"
                  type="button"
                  onClick={() => {
                    refreshSystemDiagnostics().catch(() => {});
                  }}
                >
                  刷新状态
                </button>
              </div>
            </div>

            <div className="fx-section-label">Wallpaper Engine 本地项目</div>
            <div className="cache-storage-panel">
              <div className="cache-storage-actions">
                <button
                  className="fx-mini-btn ghost"
                  type="button"
                  disabled={weLoading}
                  onClick={() => {
                    handleAddWeDir().catch(() => {});
                  }}
                >
                  添加 WE 目录
                </button>
                {activeWeId && (
                  <button
                    className="fx-mini-btn ghost"
                    type="button"
                    onClick={() => {
                      handleStopWeProject().catch(() => {});
                    }}
                  >
                    停用当前壁纸
                  </button>
                )}
              </div>

              {weRoots.length > 0 && (
                <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
                  {weRoots.map((root, idx) => {
                    const rId = String(root.id || root.rootId || '');
                    return (
                      <div
                        key={rId || idx}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 8,
                          fontSize: 11,
                        }}
                      >
                        <code className="cache-storage-path small" style={{ flex: 1, margin: 0 }}>
                          {root.name || root.path || rId}
                        </code>
                        {rId && (
                          <button
                            type="button"
                            className="fx-mini-btn ghost"
                            onClick={() => {
                              handleRemoveWeRoot(rId).catch(() => {});
                            }}
                          >
                            清除目录
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="wallpaper-engine-grid" style={{ marginTop: 8 }}>
                {visibleWeProjects.length === 0 ? (
                  <div className="fx-sub">暂无本地索引项目，点击“添加 WE 目录”扫描</div>
                ) : (
                  visibleWeProjects.slice(0, 12).map((proj) => (
                    <div
                      key={proj.id}
                      className="queue-item"
                      onClick={() => {
                        handleStartWeProject(proj).catch(() => {});
                      }}
                    >
                      <div className="qi-info">
                        <div className="qi-name">{proj.title}</div>
                        <div className="qi-sub">{proj.type || 'scene'}</div>
                      </div>
                      <button
                        type="button"
                        className="fx-mini-btn ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (activeWeId === proj.id) {
                            handleStopWeProject().catch(() => {});
                          } else {
                            handleStartWeProject(proj).catch(() => {});
                          }
                        }}
                      >
                        {activeWeId === proj.id ? '停用' : '启用'}
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

export default FxConsoleModal;
