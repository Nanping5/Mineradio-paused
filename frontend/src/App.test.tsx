import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { DesktopLyricsApp } from './DesktopLyricsApp';
import { AccountAndLoginModal } from './components/AccountAndLoginModal';
import {
  FxConsoleModal,
  extractWeRoots,
  resolveWeProjectMediaType,
} from './components/FxConsoleModal';
import { PlayerControls } from './components/PlayerControls';
import { PlaylistDrawer } from './components/PlaylistDrawer';
import { SearchBar } from './components/SearchBar';
import { TrackDetailModal } from './components/TrackDetailModal';
import { desktopWindow, emitLocalEvent } from './bridge/tauriBridge';
import { usePlayerStore } from './store/playerStore';
import { DEFAULT_FX_SETTINGS } from './types/mineradio';

describe('Mineradio UI & Desktop Lyrics', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage?.clear();

    if (typeof globalThis.ResizeObserver === 'undefined') {
      globalThis.ResizeObserver = class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    usePlayerStore.setState({
      playQueue: [],
      currentIdx: -1,
      currentSong: null,
      playing: false,
      currentTime: 0,
      duration: 0,
      volume: 0.72,
      muted: false,
      playMode: 'loop',
      quality: 'exhigh',
      audioError: null,
      automixEnabled: false,
      cuefieldStatus: 'disabled',
      lyrics: [],
      activeLyricIdx: -1,
      lyricOffsetSec: 0,
      desktopLyricsEnabled: false,
      desktopLyricsLocked: false,
      searchMode: 'song',
      searchQuery: '',
      searchResults: [],
      searchLoading: false,
      homeDiscover: null,
      weatherRadio: null,
      userPlaylists: [],
      builtInPlaylists: [],
      localTracks: [],
      activePlaylistTracks: [],
      easterEggUnlocked: false,
      fx: { ...DEFAULT_FX_SETTINGS },
      activePreset: 0,
      diyMode: false,
      shelfOpen: false,
      fxPanelOpen: false,
      playlistPanelOpen: false,
      splashDone: true,
      updateInfo: null,
      trackDetailOpen: false,
      trackDetailSong: null,
      customLyricModalOpen: false,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('App 挂载渲染核心区域与 DOM 骨架', async () => {
    const { container } = render(<App />);

    expect(container.querySelector('#desktop-window-shell')).not.toBeNull();
    expect(container.querySelector('#desktop-titlebar')).not.toBeNull();
    expect(container.querySelector('#custom-bg')).not.toBeNull();
    expect(container.querySelector('#wallpaper-engine-layer')).not.toBeNull();
    expect(container.querySelector('#album-bg')).not.toBeNull();
    expect(container.querySelector('#canvas-container')).not.toBeNull();
    expect(container.querySelector('#search-area')).not.toBeNull();
    expect(container.querySelector('#empty-home')).not.toBeNull();
    expect(container.querySelector('#controls')).not.toBeNull();
    expect(container.querySelector('#fx-panel')).not.toBeNull();
    expect(container.querySelector('#playlist-panel')).not.toBeNull();
    expect(container.querySelector('#desktop-mode-control-dock')).not.toBeNull();

    await waitFor(() => {
      expect(document.body.classList.contains('desktop-shell')).toBe(true);
    });
  });

  it('SearchBar 支持搜索模式切换与搜索结果渲染', async () => {
    const searchSpy = vi.fn(
      async (query: string, mode?: 'song' | 'netease' | 'qq' | 'kugou' | 'qishui' | 'podcast') => {
        const mockResults = [
          {
            id: '101',
            name: `${query}-测试曲目`,
            artist: '测试歌手',
            album: '测试专辑',
            provider: (mode === 'qq' ? 'qq' : 'netease') as 'qq' | 'netease',
          },
        ];
        usePlayerStore.setState({ searchResults: mockResults, searchLoading: false });
        return mockResults;
      }
    );
    usePlayerStore.setState({ searchTracks: searchSpy });

    render(<SearchBar />);

    const input = screen.getByPlaceholderText('搜索歌曲、歌手...');
    fireEvent.change(input, { target: { value: '晴天' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(searchSpy).toHaveBeenCalledWith('晴天', 'song');
    });
    expect(await screen.findByText('晴天-测试曲目')).toBeTruthy();

    const qqTab = screen.getByRole('tab', { name: 'QQ' });
    fireEvent.click(qqTab);

    await waitFor(() => {
      expect(usePlayerStore.getState().searchMode).toBe('qq');
      expect(searchSpy).toHaveBeenCalledWith('晴天', 'qq');
    });
  });

  it('AccountAndLoginModal 轻触 5 次大小眼才显示暗号输入框且无答案剧透，支持“世界和平”彩蛋解锁并进入多平台登录', async () => {
    const unlockSpy = vi.fn(async (password: string) => {
      const ok = password.trim() === '世界和平';
      if (ok) {
        usePlayerStore.setState({ easterEggUnlocked: true });
      }
      return {
        ok,
        gateVersion: 'world-peace-v1',
        unlocked: ok,
        resetComplete: true,
        message: ok ? '已解锁全平台登录入口' : '暗号错误',
      };
    });
    usePlayerStore.setState({
      easterEggUnlocked: false,
      unlockEasterEgg: unlockSpy,
    });

    const { container } = render(<AccountAndLoginModal />);

    const userBtn = screen.getByRole('button', { name: '账号与登录' });
    fireEvent.click(userBtn);

    // 初始未轻触 5 次大小眼时，不应显示暗号输入框，且无“世界和平”答案剧透
    expect(screen.queryByLabelText('输入四个字的愿望')).toBeNull();
    expect(container.querySelector('#login-easter-egg-gate')?.textContent).not.toContain('世界和平');

    const eyeTrigger = screen.getByRole('button', { name: '轻触大小眼' });
    for (let i = 0; i < 4; i++) {
      fireEvent.click(eyeTrigger);
      expect(screen.queryByLabelText('输入四个字的愿望')).toBeNull();
    }

    // 第 5 次轻触后显示暗号输入框，且仍无答案剧透
    fireEvent.click(eyeTrigger);
    const wishInput = screen.getByLabelText('输入四个字的愿望');
    expect(wishInput).toBeTruthy();
    expect(container.querySelector('#login-easter-egg-gate')?.textContent).not.toContain('世界和平');

    fireEvent.change(wishInput, { target: { value: '世界和平' } });
    fireEvent.click(screen.getByRole('button', { name: '解锁登录' }));

    await waitFor(() => {
      expect(unlockSpy).toHaveBeenCalledWith('世界和平');
    });

    expect(await screen.findByText('网易云')).toBeTruthy();
    expect(screen.getByText('QQ 音乐')).toBeTruthy();
    expect(screen.getByText('酷狗音乐')).toBeTruthy();
    expect(screen.getByText('汽水音乐')).toBeTruthy();
  });

  it('FxConsoleModal 支持 Preset 7/8 专属参数面板及系统缓存与内存字段展示', async () => {
    vi.spyOn(desktopWindow, 'getCacheSettings').mockResolvedValue({
      ok: true,
      cDriveProtected: true,
      settings: {
        rootPath: 'D:\\MineradioCache',
        lyricsPath: 'D:\\MineradioCache\\lyrics',
        beatmapsPath: 'D:\\MineradioCache\\beatmaps',
        wallpaperEnginePath: 'D:\\MineradioCache\\we',
        userDataPath: 'D:\\MineradioCache\\userdata',
      },
      usage: {
        lyricsBytes: 2 * 1024 * 1024,
        beatmapsBytes: 5 * 1024 * 1024,
        wallpaperEngineBytes: 10 * 1024 * 1024,
        userDataBytes: 1 * 1024 * 1024,
        totalManagedBytes: 18 * 1024 * 1024,
      },
    });
    vi.spyOn(desktopWindow, 'getMemorySnapshot').mockResolvedValue({
      supported: true,
      totalMB: 16384,
      usedMB: 8192,
      usedPercent: 50,
      process: {
        rssMB: 320.5,
        privateMB: 280.2,
      },
    });

    usePlayerStore.setState({
      fxPanelOpen: true,
      activePreset: 7,
      fx: { ...DEFAULT_FX_SETTINGS, preset: 7 },
    });

    const { container } = render(<FxConsoleModal />);

    // 切换到“动效”页签验证 Preset 7 专属参数
    fireEvent.click(screen.getByRole('tab', { name: '动效' }));
    expect(container.querySelector('#fx-preset-7-panel')).not.toBeNull();
    expect(screen.getByText('Preset 7 · Sonic Ground')).toBeTruthy();
    expect(screen.getByText('地形振幅')).toBeTruthy();

    // 切换到 Preset 8 验证 Preset 8 专属参数
    act(() => {
      usePlayerStore.setState({
        activePreset: 8,
        fx: { ...DEFAULT_FX_SETTINGS, preset: 8 },
      });
    });
    expect(container.querySelector('#fx-preset-8-panel')).not.toBeNull();
    expect(screen.getByText('Preset 8 · Sonic Workshop')).toBeTruthy();
    expect(screen.getByText('输入压制')).toBeTruthy();

    // 切换到“系统”页签验证缓存与内存诊断字段显示
    fireEvent.click(screen.getByRole('tab', { name: '系统' }));
    await waitFor(() => {
      expect(container.querySelector('#cache-storage-root')?.textContent).toBe('D:\\MineradioCache');
    });
    expect(container.querySelector('#cache-usage-total')?.textContent).toBe('18.0 MB');
    expect(container.querySelector('#mem-total')?.textContent).toBe('16.00 GB');
    expect(container.querySelector('#mem-process')?.textContent).toBe('320.5 MB');
  });

  it('TrackDetailModal 打开渲染歌曲信息并加载热门与最新评论列表', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/song/comments')) {
        return new Response(
          JSON.stringify({
            hotComments: [
              {
                commentId: 'h1',
                content: '这首粒子视觉绝了！',
                likedCount: 88,
                user: { nickname: '热评听友' },
              },
            ],
            comments: [
              {
                commentId: 'c1',
                content: '深夜听歌打卡',
                likedCount: 5,
                user: { nickname: '夜航船' },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    usePlayerStore.setState({
      trackDetailOpen: true,
      trackDetailSong: {
        id: '2026',
        name: '星空漫游',
        artist: 'Mineradio Band',
        album: 'Cosmic Horizons',
        provider: 'netease',
      },
    });

    const { container } = render(<TrackDetailModal />);

    expect(container.querySelector('#track-detail-modal')).not.toBeNull();
    expect(screen.getByText('星空漫游')).toBeTruthy();
    expect(screen.getByText(/Mineradio Band/)).toBeTruthy();

    expect(await screen.findByText('这首粒子视觉绝了！')).toBeTruthy();
    expect(screen.getByText('热评听友')).toBeTruthy();
    expect(screen.getByText('深夜听歌打卡')).toBeTruthy();
    expect(screen.getByText('夜航船')).toBeTruthy();
  });

  it('DesktopLyricsApp 挂载主动调用 desktopLyricsGetState 立即渲染初始歌词，并监听状态事件与支持锁定切换', async () => {
    const getStateSpy = vi.spyOn(desktopWindow, 'desktopLyricsGetState').mockResolvedValue({
      ok: true,
      enabled: true,
      locked: false,
      payload: {
        line: '首帧初始桌面歌词',
        translation: 'Initial desktop lyric frame',
        nextLine: '下一句紧随其后',
        playing: true,
        progress: 0.25,
      },
    });
    const lockSpy = vi
      .spyOn(desktopWindow, 'setDesktopLyricsLockState')
      .mockResolvedValue({ ok: true, locked: true });
    const enabledSpy = vi
      .spyOn(desktopWindow, 'setDesktopLyricsEnabled')
      .mockResolvedValue({ ok: true, enabled: false });

    render(<DesktopLyricsApp />);

    await waitFor(() => {
      expect(getStateSpy).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByText('首帧初始桌面歌词')).toBeTruthy();
    expect(screen.getByTestId('desktop-lyrics-translation').textContent).toBe(
      'Initial desktop lyric frame'
    );

    act(() => {
      emitLocalEvent('mineradio-desktop-lyrics-state', {
        line: '夜空中最亮的星',
        translation: 'The brightest star in the night sky',
        nextLine: '能否听清',
        playing: true,
        progress: 0.45,
        locked: false,
      });
    });

    expect(await screen.findByText('夜空中最亮的星')).toBeTruthy();
    expect(screen.getByTestId('desktop-lyrics-translation').textContent).toBe(
      'The brightest star in the night sky'
    );
    expect(screen.getByTestId('desktop-lyrics-next').textContent).toBe('能否听清');

    const lockBtn = screen.getByRole('button', { name: '锁定穿透' });
    fireEvent.click(lockBtn);
    await waitFor(() => {
      expect(lockSpy).toHaveBeenCalledWith(true);
    });

    const closeBtn = screen.getByRole('button', { name: '关闭桌面歌词' });
    fireEvent.click(closeBtn);
    await waitFor(() => {
      expect(enabledSpy).toHaveBeenCalledWith(false);
    });
  });

  it('AccountAndLoginModal 网易云二维码轮询 802 -> 803 后立即同步登录态并关闭弹窗', async () => {
    vi.useFakeTimers();
    try {
      usePlayerStore.setState({ easterEggUnlocked: true });
      const onCloseLoginModal = vi.fn();
      const onToast = vi.fn();

      let checkCalls = 0;
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes('/api/login/qr/key')) {
          return new Response(JSON.stringify({ key: 'qr-key-test' }), { status: 200 });
        }
        if (url.includes('/api/login/qr/create')) {
          return new Response(
            JSON.stringify({ img: 'data:image/png;base64,AAA', url: 'https://music.163.com/login?codekey=qr-key-test' }),
            { status: 200 }
          );
        }
        if (url.includes('/api/login/qr/check')) {
          checkCalls += 1;
          if (checkCalls === 1) {
            return new Response(JSON.stringify({ code: 802, message: '待确认' }), { status: 200 });
          }
          return new Response(
            JSON.stringify({
              code: 803,
              loggedIn: true,
              hasCookie: true,
              userId: '123456',
              nickname: '测试云村用户',
              avatar: 'https://example.com/a.png',
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ loggedIn: true, nickname: '测试云村用户' }), { status: 200 });
      });

      render(
        <AccountAndLoginModal
          loginModalOpen={true}
          onCloseLoginModal={onCloseLoginModal}
          onToast={onToast}
        />
      );

      const getQrBtn = screen.getByRole('button', { name: '获取二维码登录' });
      await act(async () => {
        fireEvent.click(getQrBtn);
        await Promise.resolve();
      });

      expect(screen.getByAltText('netease 登录二维码')).toBeTruthy();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1100);
      });
      expect(screen.getByText('已扫码，请在手机确认登录…')).toBeTruthy();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1900);
      });

      expect(usePlayerStore.getState().platformLogins.netease.loggedIn).toBe(true);
      expect(usePlayerStore.getState().platformLogins.netease.nickname).toBe('测试云村用户');
      expect(onCloseLoginModal).toHaveBeenCalledTimes(1);
      expect(onToast).toHaveBeenCalledWith('网易云已登录：测试云村用户');
      fetchMock.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('FxConsoleModal 正确解析 WE manualRoots / %2Emp4 视频、Preset 7/8 量程与 closeBehavior', async () => {
    expect(extractWeRoots({ manualRoots: [{ id: 'r1', name: 'Workshop' }] })).toEqual([
      { id: 'r1', name: 'Workshop' },
    ]);
    expect(
      resolveWeProjectMediaType(
        { type: 'scene', file: 'scene.pkg' },
        'mineradio-wallpaper://media/abc123?path=sub%2Floop%2Emp4&cap=tok1'
      )
    ).toBe('video');

    vi.spyOn(desktopWindow, 'getCloseBehavior').mockResolvedValue({ behavior: 'quit' });
    vi.spyOn(desktopWindow, 'listWallpaperEngineProjects').mockResolvedValue({
      ok: true,
      projects: [],
      manualRoots: [{ id: 'r-manual', name: '我的壁纸目录' }],
    } as never);

    usePlayerStore.setState({
      fxPanelOpen: true,
      activePreset: 7,
      fx: { ...DEFAULT_FX_SETTINGS, preset: 7, sonicGroundColorMode: 'cover' },
    });

    const { container } = render(<FxConsoleModal />);

    // 切换到动效 Tab 检查 Preset 7 滑块量程与选色自动切到 custom
    fireEvent.click(screen.getByRole('tab', { name: '动效' }));
    const ampSlider = container.querySelector('#fx-sonicGroundAmplitude') as HTMLInputElement;
    expect(ampSlider.min).toBe('0');
    expect(ampSlider.max).toBe('100');

    const baseColorPicker = container.querySelector('#fx-sonicGroundBaseColor') as HTMLInputElement;
    fireEvent.change(baseColorPicker, { target: { value: '#123456' } });
    expect(usePlayerStore.getState().fx.sonicGroundColorMode).toBe('custom');

    // Preset 8 输入压制量程验证
    act(() => {
      usePlayerStore.setState({
        activePreset: 8,
        fx: { ...DEFAULT_FX_SETTINGS, preset: 8 },
      });
    });
    const wsGain = container.querySelector('#fx-sonicWorkshopInputGain') as HTMLInputElement;
    expect(wsGain.min).toBe('40');
    expect(wsGain.max).toBe('100');

    // 切换到系统 Tab 验证 closeBehavior 'quit' 回显与 manualRoots 显示
    fireEvent.click(screen.getByRole('tab', { name: '系统' }));
    await waitFor(() => {
      expect(screen.getByText('我的壁纸目录')).toBeTruthy();
      expect(screen.getByRole('button', { name: '直接退出' }).className).toContain('active');
    });
  });

  it('FxConsoleModal 系统页退出应用按钮需二次确认并调用 quit 关闭', async () => {
    const closeSpy = vi.spyOn(desktopWindow, 'close').mockResolvedValue({ ok: true } as never);
    usePlayerStore.setState({ fxPanelOpen: true });

    render(<FxConsoleModal />);
    fireEvent.click(screen.getByRole('tab', { name: '系统' }));

    const quitBtn = await screen.findByRole('button', { name: '退出应用（彻底结束进程）' });
    fireEvent.click(quitBtn);
    expect(closeSpy).not.toHaveBeenCalled();

    const armedBtn = await screen.findByRole('button', { name: '再次点击确认退出应用' });
    fireEvent.click(armedBtn);
    await waitFor(() => expect(closeSpy).toHaveBeenCalledWith('quit'));
    closeSpy.mockRestore();
  });

  it('TrackDetailModal 汽水评论使用 /api/qishui/song/comments 契约端点', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/qishui/song/comments')) {
        return new Response(
          JSON.stringify({
            comments: [{ commentId: 'c1', content: '汽水热评', user: { nickname: '听众A' } }],
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });

    usePlayerStore.setState({
      trackDetailOpen: true,
      currentSong: { id: 'qs-1', name: '汽水测试', provider: 'qishui', source: 'qishui' },
    });

    render(<TrackDetailModal />);

    await waitFor(() => {
      expect(screen.getByText('汽水热评')).toBeTruthy();
    });
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).includes('/api/qishui/song/comments?id=qs-1'))
    ).toBe(true);
  });

  it('PlaylistDrawer 我的播客读取 collections 并通过 ?key= 拉取节目', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/podcast/my/items')) {
        return new Response(
          JSON.stringify({
            itemType: 'program',
            items: [{ id: 'prog-1', name: '第一期节目', artist: '主播X' }],
          }),
          { status: 200 }
        );
      }
      if (url.includes('/api/podcast/my')) {
        return new Response(
          JSON.stringify({
            loggedIn: true,
            collections: [{ key: 'collect', title: '我订阅的播客', sub: '2个电台', count: 2 }],
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    usePlayerStore.setState({ playlistPanelOpen: true });
    render(<PlaylistDrawer />);

    fireEvent.click(screen.getByRole('tab', { name: '我的播客' }));
    await waitFor(() => {
      expect(screen.getByText(/我订阅的播客/)).toBeTruthy();
    });

    fireEvent.click(screen.getByText(/我订阅的播客/));
    await waitFor(() => {
      expect(screen.getByText('第一期节目')).toBeTruthy();
    });
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).includes('/api/podcast/my/items?key=collect'))
    ).toBe(true);
  });

  it('AccountAndLoginModal 在 QQ 标签下可正常收起 Cookie 面板且 QQ 红心点赞明确提示不支持', async () => {
    usePlayerStore.setState({ easterEggUnlocked: true });
    const { container } = render(<AccountAndLoginModal loginModalOpen={true} />);

    fireEvent.click(container.querySelector('#login-provider-qq') as HTMLButtonElement);
    const cookiePanel = container.querySelector('#qq-cookie-panel') as HTMLElement;
    expect(cookiePanel.className).toContain('show');

    fireEvent.click(container.querySelector('#qq-cookie-toggle-btn') as HTMLButtonElement);
    expect(cookiePanel.className).not.toContain('show');

    cleanup();

    const onToast = vi.fn();
    usePlayerStore.setState({
      currentSong: { id: 'qq-1', mid: 'mid-1', name: 'QQ歌', provider: 'qq', source: 'qq' },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { container: ctrlContainer } = render(<PlayerControls onToast={onToast} />);
    const likeBtn = ctrlContainer.querySelector('#heart-btn') as HTMLButtonElement;
    fireEvent.click(likeBtn);
    expect(onToast).toHaveBeenCalledWith('QQ 音乐暂不支持红心收藏，请前往 QQ 音乐客户端操作');
    expect(fetchSpy.mock.calls.some(([u]) => String(u).includes('/api/qq/like'))).toBe(false);
  });

  it('已登录账号顶栏头像保持 34x34 紧凑尺寸且网易云毫秒时长自动换算为秒', async () => {
    usePlayerStore.setState({
      platformLogins: {
        netease: {
          loggedIn: true,
          nickname: '极长昵称测试账号超过十个字',
          avatar: 'https://example.com/big-avatar.jpg',
        },
        qq: { loggedIn: false },
        kugou: { loggedIn: false },
        qishui: { loggedIn: false },
      },
    });
    const { container } = render(<AccountAndLoginModal />);
    const btn = container.querySelector('#user-btn') as HTMLButtonElement;
    const avatar = container.querySelector('#user-avatar') as HTMLImageElement;
    expect(btn.style.maxWidth).toBe('168px');
    expect(avatar.style.width).toBe('34px');
    expect(avatar.style.height).toBe('34px');

    await usePlayerStore.getState().playSong({
      id: '3451586363',
      name: 'Claude Opus 5.5の小曲',
      provider: 'netease',
      duration: 134306,
    });
    expect(usePlayerStore.getState().duration).toBe(134);
  });

  it('切换 DIY 模式时同步移除 html.simple-mode-preload、点亮 .on 指示灯并可开关 FX 控制台', async () => {
    document.documentElement.className = 'simple-mode-preload startup-fast-skip-preload';
    usePlayerStore.setState({ diyMode: false, fxPanelOpen: false, splashDone: true });

    const { container } = render(<App />);

    const diyBtn = container.querySelector('#diy-mode-btn') as HTMLButtonElement;
    const fullscreenDiyBtn = container.querySelector('#fullscreen-diy-btn') as HTMLButtonElement;
    const fxFab = container.querySelector('#fx-fab') as HTMLButtonElement;
    const fxPanel = container.querySelector('#fx-panel') as HTMLElement;
    const fxToggleBtn = container.querySelector('#fx-panel-toggle-btn') as HTMLButtonElement;

    expect(diyBtn).not.toBeNull();
    expect(fullscreenDiyBtn).not.toBeNull();
    expect(diyBtn.className).not.toContain(' on');
    expect(document.documentElement.classList.contains('simple-mode-preload')).toBe(true);
    expect(document.documentElement.classList.contains('startup-fast-skip-preload')).toBe(false);
    expect(document.body.classList.contains('simple-mode')).toBe(true);

    fireEvent.click(diyBtn);
    await waitFor(() => {
      expect(usePlayerStore.getState().diyMode).toBe(true);
      expect(diyBtn.classList.contains('on')).toBe(true);
      expect(fullscreenDiyBtn.classList.contains('on')).toBe(true);
      expect(document.documentElement.classList.contains('simple-mode-preload')).toBe(false);
      expect(document.documentElement.classList.contains('diy-mode-preload')).toBe(true);
      expect(document.body.classList.contains('diy-mode')).toBe(true);
    });

    fireEvent.click(fxFab);
    await waitFor(() => {
      expect(usePlayerStore.getState().fxPanelOpen).toBe(true);
      expect(fxPanel.classList.contains('show')).toBe(true);
      expect(fxPanel.getAttribute('aria-hidden')).toBe('false');
    });

    fireEvent.click(fxToggleBtn);
    await waitFor(() => {
      expect(usePlayerStore.getState().fxPanelOpen).toBe(false);
      expect(fxPanel.classList.contains('show')).toBe(false);
    });

    fireEvent.click(fxToggleBtn);
    await waitFor(() => {
      expect(usePlayerStore.getState().fxPanelOpen).toBe(true);
      expect(fxPanel.classList.contains('show')).toBe(true);
    });

    fireEvent.click(diyBtn);
    await waitFor(() => {
      expect(usePlayerStore.getState().diyMode).toBe(false);
      expect(usePlayerStore.getState().fxPanelOpen).toBe(false);
      expect(fxPanel.classList.contains('show')).toBe(false);
      expect(diyBtn.classList.contains('on')).toBe(false);
      expect(document.documentElement.classList.contains('simple-mode-preload')).toBe(true);
      expect(document.body.classList.contains('simple-mode')).toBe(true);
    });

    document.documentElement.className = '';
  });

  it('底栏布局与 simple-mode 隐藏规则在两份 index.css 中保持同步防重叠', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const frontendCss = fs.readFileSync(
      path.resolve(process.cwd(), 'public/css/index.css'),
      'utf8'
    );
    const rootCss = fs.readFileSync(
      path.resolve(process.cwd(), '../public/css/index.css'),
      'utf8'
    );
    expect(frontendCss).toBe(rootCss);
    expect(frontendCss).toContain('body.simple-mode #shelf-toggle-btn');
    expect(frontendCss).toContain('body.simple-mode #fx-panel-toggle-btn');
    expect(frontendCss).toContain(
      'grid-template-columns: minmax(0, 1fr) max-content minmax(max-content, 1fr);'
    );
  });

  it('应用内界面标题、启动页词标与控制台品牌均显示 MineradioX', () => {
    usePlayerStore.setState({ splashDone: false });
    const { container } = render(<App />);
    expect(container.querySelector('.desktop-app-title')?.textContent).toBe('MineradioX');
    expect(container.querySelector('#splash-wordmark')?.getAttribute('aria-label')).toBe(
      'MineradioX'
    );
    expect(container.querySelector('.splash-word-x')?.textContent).toBe('X');
    expect(container.querySelector('.fx-sub')?.textContent).toContain('MINERADIOX VISUALS');
    expect(container.querySelector('#empty-home')?.getAttribute('aria-label')).toBe(
      'MineradioX 音乐首页'
    );
  });
});
