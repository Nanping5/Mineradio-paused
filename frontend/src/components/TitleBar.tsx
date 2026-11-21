import React, { useEffect, useState } from 'react';
import { desktopWindow } from '../bridge/tauriBridge';
import { usePlayerStore } from '../store/playerStore';

export interface TitleBarProps {
  isMaximized?: boolean;
  isFullScreen?: boolean;
  onOpenGuide?: () => void;
  onOpenUpdate?: () => void;
}

const DIY_MODE_LS_KEY = 'mineradio-diy-player-mode-v1';

export function TitleBar({
  isMaximized = false,
  isFullScreen = false,
  onOpenGuide,
  onOpenUpdate,
}: TitleBarProps): React.ReactElement {
  const diyMode = usePlayerStore((s) => s.diyMode);
  const setDiyMode = usePlayerStore((s) => s.setDiyMode);
  const updateInfo = usePlayerStore((s) => s.updateInfo);
  const [windowMaximized, setWindowMaximized] = useState(isMaximized);
  const [closeBehavior, setCloseBehavior] = useState<string>('tray');

  useEffect(() => {
    setWindowMaximized(isMaximized);
  }, [isMaximized]);

  useEffect(() => {
    const unlisten = desktopWindow.onStateChange((state) => {
      if (typeof state?.isMaximized === 'boolean') {
        setWindowMaximized(state.isMaximized);
      }
      if (typeof state?.closeBehavior === 'string' && state.closeBehavior) {
        setCloseBehavior(state.closeBehavior);
      }
    });
    return unlisten;
  }, []);

  useEffect(() => {
    desktopWindow
      .getCloseBehavior()
      .then((res) => {
        if (res && typeof res.behavior === 'string' && res.behavior) {
          setCloseBehavior(res.behavior);
        }
      })
      .catch(() => {});
  }, []);

  const hasUpdate = Boolean(updateInfo?.updateAvailable ?? updateInfo?.hasUpdate);

  const handleToggleDiy = () => {
    const next = !diyMode;
    setDiyMode(next);
    try {
      window.localStorage?.setItem(DIY_MODE_LS_KEY, next ? '1' : '0');
    } catch {
      // ignore storage failure
    }
  };

  return (
    <>
      <div id="desktop-titlebar" aria-label="window controls">
        <div className="desktop-drag-region" data-tauri-drag-region>
          <div className="desktop-app-mark" aria-hidden="true" />
          <div className="desktop-app-title" aria-hidden="true">
            MineradioX
          </div>
        </div>
        <div className="desktop-window-controls">
          <button
            id="visual-guide-btn"
            className="icon-btn"
            type="button"
            onClick={() => onOpenGuide?.()}
            title="查看使用引导"
            aria-label="查看使用引导"
          >
            ?
          </button>
          <button
            id="update-entry"
            className={`update-entry${hasUpdate ? ' available' : ''}`}
            type="button"
            onClick={() => onOpenUpdate?.()}
            title={hasUpdate ? `发现新版本 ${updateInfo?.latestVersion || ''}` : '检查更新'}
            aria-label={hasUpdate ? '发现新版本' : '检查更新'}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle className="update-ring" cx="12" cy="12" r="8.8" />
              <circle
                id="update-progress-ring"
                className="update-progress-ring"
                cx="12"
                cy="12"
                r="8.8"
              />
              <path className="update-arrow" d="M12 16.5V7.5" />
              <path className="update-arrow" d="M8.7 10.7 12 7.4l3.3 3.3" />
            </svg>
          </button>
          <button
            id="diy-mode-btn"
            className={`desktop-mode-btn${diyMode ? ' on' : ''}`}
            type="button"
            onClick={handleToggleDiy}
            title={diyMode ? '关闭 DIY 玩家模式' : '开启 DIY 玩家模式'}
            aria-label={diyMode ? '关闭 DIY 玩家模式' : '开启 DIY 玩家模式'}
            aria-pressed={diyMode}
          >
            DIY
          </button>
          <button
            className="desktop-window-btn"
            type="button"
            data-window-action="minimize"
            onClick={() => {
              desktopWindow.minimize().catch(() => {});
            }}
            title="最小化"
            aria-label="最小化"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3 8h10" />
            </svg>
          </button>
          <button
            className="desktop-window-btn"
            type="button"
            data-window-action="maximize"
            onClick={() => {
              desktopWindow.toggleMaximize().catch(() => {});
            }}
            title={windowMaximized ? '还原' : '最大化'}
            aria-label={windowMaximized ? '还原' : '最大化'}
          >
            {windowMaximized ? (
              <svg className="icon-restore" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M5 3.5h7.5v7.5" />
                <rect x="3.5" y="5.5" width="7" height="7" rx="1.3" />
              </svg>
            ) : (
              <svg className="icon-maximize" viewBox="0 0 16 16" aria-hidden="true">
                <rect x="4" y="4" width="8" height="8" rx="1.5" />
              </svg>
            )}
          </button>
          <button
            className="desktop-window-btn close"
            type="button"
            data-window-action="close"
            onClick={() => {
              desktopWindow.close().catch(() => {});
            }}
            title={closeBehavior === 'tray' ? '关闭（最小化到托盘）' : '关闭（退出应用）'}
            aria-label={closeBehavior === 'tray' ? '关闭（最小化到托盘）' : '关闭（退出应用）'}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
      </div>

      <div id="fullscreen-diy-zone" aria-hidden={!isFullScreen}>
        <button
          id="fullscreen-diy-btn"
          className={`desktop-mode-btn${diyMode ? ' on' : ''}`}
          type="button"
          onClick={handleToggleDiy}
          title="DIY"
          aria-label="DIY"
          aria-pressed={diyMode}
        >
          DIY
        </button>
      </div>
    </>
  );
}

export default TitleBar;
