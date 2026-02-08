
import React, { useState, useRef, useEffect } from 'react';
import Header from './components/header.tsx';
import Sidebar from './components/sidebar.tsx';
import NovelInput from './components/novelinput.tsx';
import NovelDisplay from './components/noveldisplay.tsx';
import { NovelContent, ReaderState } from './types.ts';
import { fetchNovelContent } from './services/geminiService.ts';
import { getSafeOpenUrl } from './utils/urlUtils.ts';

const STORAGE_KEY_SETTINGS = 'gemini_reader_settings';
const STORAGE_KEY_PROGRESS = 'gemini_reader_progress';

/** 從 novel 取得要朗讀的純文字（支援多種後端回傳格式，含 HTML） */
function getNovelText(novel: NovelContent | null): string {
  if (!novel) return '';
  const n = novel as any;
  const candidates: string[] = [];
  const push = (s: unknown) => {
    if (typeof s === 'string' && s.length > 0) candidates.push(s);
  };
  push(n.content);
  push(n.fullContent);
  push(n.text);
  push(n.body);
  push(n.articleText);
  push(n.html);
  if (n.data) {
    push(n.data.content);
    push(n.data.text);
    push(n.data.body);
    push(n.data.html);
  }
  if (n.chapter) {
    push(n.chapter.text);
    push(n.chapter.content);
    push(n.chapter.body);
    push(n.chapter.html);
  }
  const chapters = n.chapters ?? n.data?.chapters;
  if (Array.isArray(chapters)) {
    const joined = chapters.map((c: any) => c.text ?? c.content ?? c.body ?? c.html ?? '').join('\n');
    if (joined.trim()) candidates.push(joined);
  }
  if (candidates.length > 0) {
    const best = candidates.reduce((a, b) => (a.length >= b.length ? a : b));
    if (best.length > 0) return ensurePlainText(best);
  }
  // 後備：從物件中找最長的像內文的字串（排除 URL、title 等）
  const seen = new Set<string>();
  const collect = (obj: any): void => {
    if (!obj || typeof obj !== 'object') return;
    for (const key of Object.keys(obj)) {
      const v = obj[key];
      if (typeof v === 'string') {
        if (v.length < 50) continue;
        if (/^https?:\/\//i.test(v) || key === 'sourceUrl' || key === 'url') continue;
        if (/[\u4e00-\u9fff]/.test(v) && !seen.has(v)) {
          seen.add(v);
          candidates.push(v);
        }
      } else if (Array.isArray(v)) {
        v.forEach((item: any) => collect(item));
      } else if (typeof v === 'object') {
        collect(v);
      }
    }
  };
  collect(n);
  if (candidates.length > 0) {
    const best = candidates.reduce((a, b) => (a.length >= b.length ? a : b));
    return ensurePlainText(best);
  }
  return '';
}

/** 從 HTML 或混合內容擷取純文字（供貼上文章使用） */
function htmlToPlainText(html: string): string {
  if (!html || !html.trim()) return '';
  const div = document.createElement('div');
  div.innerHTML = html.trim();
  const text = (div.textContent || div.innerText || '').replace(/\s+/g, ' ').trim();
  return text;
}

/** 若字串像 HTML 則轉成純文字，否則原樣回傳 */
function ensurePlainText(s: string): string {
  if (!s || s.length < 10) return s;
  if (/<[a-zA-Z][\s\S]*>/.test(s)) return htmlToPlainText(s);
  return s;
}

/** 將文字切成適合 Web Speech API 的短句（依標點再依長度） */
function splitForBrowserTTS(text: string, maxLen = 120): string[] {
  const byPunct = text.split(/([。！？\n]+)/).filter(Boolean);
  const parts: string[] = [];
  let acc = '';
  for (let i = 0; i < byPunct.length; i++) {
    acc += byPunct[i];
    const trimmed = acc.trim();
    if (trimmed.length >= maxLen || /[。！？]$/.test(trimmed)) {
      if (trimmed.length > maxLen) {
        for (let j = 0; j < trimmed.length; j += maxLen) parts.push(trimmed.slice(j, j + maxLen));
      } else if (trimmed) parts.push(trimmed);
      acc = '';
    }
  }
  if (acc.trim()) parts.push(acc.trim());
  return parts.filter(p => p.length > 0);
}

const App: React.FC = () => {
  // --- States ---
  const [novel, setNovel] = useState<NovelContent | null>(null);
  const [state, setState] = useState<ReaderState>(ReaderState.IDLE);
  const [voice, setVoice] = useState('Kore');
  const [error, setError] = useState<string | null>(null);
  const [volume, setVolume] = useState(0.8);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isBrowseOpen, setIsBrowseOpen] = useState(false);
  const [showSearch, setShowSearch] = useState(true);
  const [fontSize, setFontSize] = useState(18);
  const [theme, setTheme] = useState<'dark' | 'sepia' | 'slate'>('dark');
  const [showResumeToast, setShowResumeToast] = useState(false);
  const [debugStep, setDebugStep] = useState<string | null>(null);
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const [pasteText, setPasteText] = useState('');

  // --- Refs ---
  const browserTTSActiveRef = useRef(false);
  const browserTTSQueueRef = useRef<string[]>([]);
  const browserTTSIndexRef = useRef(0);

  // --- Initialization ---
  useEffect(() => {
    const savedSettings = localStorage.getItem(STORAGE_KEY_SETTINGS);
    if (savedSettings) {
      const s = JSON.parse(savedSettings);
      setVoice(s.voice || 'Kore');
      setVolume(s.volume ?? 0.8);
      setPlaybackRate(s.playbackRate ?? 1.0);
      setFontSize(s.fontSize ?? 18);
      setTheme(s.theme || 'dark');
    }

    const savedProgress = localStorage.getItem(STORAGE_KEY_PROGRESS);
    if (savedProgress) {
      const p = JSON.parse(savedProgress);
      if (p.novel) {
        setNovel(p.novel);
        setCurrentTime(p.currentTime || 0);
        setShowSearch(false); // 如果有紀錄，預設進入閱讀模式
        setShowResumeToast(true);
        setTimeout(() => setShowResumeToast(false), 3000);
      }
    }
  }, []);

  useEffect(() => {
    const settings = { voice, volume, playbackRate, fontSize, theme };
    localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(settings));
  }, [voice, volume, playbackRate, fontSize, theme]);

  const saveReadingProgress = (time: number) => {
    if (!novel) return;
    const progress = { novel, currentTime: time };
    localStorage.setItem(STORAGE_KEY_PROGRESS, JSON.stringify(progress));
  };

  const handleSearch = async (input: string) => {
    try {
      handleStop();
      setState(ReaderState.FETCHING);
      setError(null);
      const data = await fetchNovelContent(input);
      const extracted = getNovelText(data as NovelContent);
      setNovel({
        ...(typeof data === 'object' && data !== null ? data : {}),
        title: (data as any)?.title ?? novel?.title ?? '載入的內容',
        content: extracted || (typeof (data as any)?.content === 'string' ? (data as any).content : ''),
      } as NovelContent);
      saveReadingProgress(0);
      setShowSearch(false); // 成功載入後隱藏搜尋區域
      setState(ReaderState.IDLE);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err: any) {
      console.error(err);
      const status = err?.status ?? err?.response?.status;
      const msg = err?.message || "無法處理網址。請檢查網址是否正確。";
      if (status === 405 || String(msg).includes('405')) {
        setError('後端回傳 405：此 API 不允許目前請求方法。請確認後端已部署且接受對應的 GET/POST；或改用下方「貼上文章」直接貼內容。');
      } else {
        setError(msg);
      }
      setState(ReaderState.ERROR);
    }
  };

  const handleLoadPastedContent = () => {
    const text = htmlToPlainText(pasteText);
    if (!text || text.length < 10) {
      setError('請貼上至少一段文章內容（HTML 或純文字皆可）');
      return;
    }
    setError(null);
    setNovel({
      title: '貼上的文章',
      content: text,
    } as NovelContent);
    saveReadingProgress(0);
    setShowSearch(false);
    setState(ReaderState.IDLE);
  };

  const handleNextChapter = () => {
    // 不再支持下一章功能，因為不抓取內容
    const url = novel?.sourceUrl ? getSafeOpenUrl(novel.sourceUrl) : null;
    if (url) window.open(url, '_blank');
  };

  const getNovelUrl = (n: NovelContent | null): string => {
    if (!n) return '';
    const a = n as any;
    return a?.sourceUrl || a?.url || a?.link || a?.chapterUrl || '';
  };

  const playWithBrowserTTS = async () => {
    let text = getNovelText(novel);
    const novelUrl = getNovelUrl(novel);
    if (!text?.trim() && novelUrl) {
      setState(ReaderState.FETCHING);
      setError(null);
      try {
        const data = await fetchNovelContent(novelUrl);
        const extracted = getNovelText(data as NovelContent);
        text = extracted || (typeof (data as any)?.content === 'string' ? (data as any).content : '');
        text = ensurePlainText(text);
        setNovel((prev: NovelContent | null) => ({
          ...(typeof data === 'object' && data !== null ? data : {}),
          title: (data as any)?.title ?? (prev as any)?.title ?? '載入的內容',
          sourceUrl: novelUrl || (data as any)?.sourceUrl,
          content: text,
        } as NovelContent));
      } catch (err: any) {
        setError(err?.message || '無法取得該網址的內容，請改用「貼上文章」貼內文。');
        setState(ReaderState.IDLE);
        return;
      }
      setState(ReaderState.IDLE);
    }
    if (!text || text.length === 0) {
      setError('目前沒有可朗讀的內容。請點選單「搜尋新小說」回到首頁，在「貼上文章」區貼上小說內文（從網頁複製整段 HTML 或純文字），按「載入並可朗讀」後再按播放。');
      return;
    }
    const segments = splitForBrowserTTS(text);
    if (segments.length === 0) return;
    browserTTSActiveRef.current = true;
    browserTTSQueueRef.current = segments;
    browserTTSIndexRef.current = 0;
    setError(null);
    setState(ReaderState.PLAYING);
    setDuration(0);
    setCurrentTime(0);

    const synth = window.speechSynthesis;
    const speakNext = () => {
      if (!browserTTSActiveRef.current) return;
      const idx = browserTTSIndexRef.current;
      if (idx >= browserTTSQueueRef.current.length) {
        setState(ReaderState.IDLE);
        browserTTSActiveRef.current = false;
        return;
      }
      const seg = browserTTSQueueRef.current[idx];
      const u = new SpeechSynthesisUtterance(seg);
      u.lang = 'zh-TW';
      u.rate = playbackRate;
      u.volume = volume;
      u.onend = () => {
        browserTTSIndexRef.current++;
        speakNext();
      };
      u.onerror = () => {
        browserTTSIndexRef.current++;
        speakNext();
      };
      synth.speak(u);
    };
    speakNext();
  };

  const handlePlayPause = () => {
    if (browserTTSActiveRef.current) {
      const synth = window.speechSynthesis;
      if (state === ReaderState.PLAYING) {
        synth.pause();
        setState(ReaderState.PAUSED);
      } else {
        synth.resume();
        setState(ReaderState.PLAYING);
      }
      return;
    }
    playWithBrowserTTS();
  };
  const canPlay = !!novel;

  const handleStop = () => {
    if (browserTTSActiveRef.current) {
      window.speechSynthesis.cancel();
      browserTTSActiveRef.current = false;
      setState(ReaderState.IDLE);
      setCurrentTime(0);
    }
  };

  const handleVolumeChange = (v: number) => setVolume(v);
  const handlePlaybackRateChange = (r: number) => setPlaybackRate(r);

  const getThemeClass = () => {
    switch(theme) {
      case 'sepia': return 'bg-[#f4ecd8] text-[#5b4636] selection:bg-[#5b4636]/20';
      case 'slate': return 'bg-[#1e293b] text-slate-200 selection:bg-indigo-500/30';
      default: return 'bg-[#0b0f1a] text-slate-300 selection:bg-indigo-500/30';
    }
  };

  return (
    <div className={`min-h-screen pb-40 flex flex-col transition-colors duration-500 ${getThemeClass()}`}>
      <Header onToggleMenu={() => setIsMenuOpen(true)} />
      
      <Sidebar 
        isOpen={isMenuOpen}
        onClose={() => setIsMenuOpen(false)}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onOpenBrowse={() => setIsBrowseOpen(true)}
        onOpenLibrary={() => setIsBrowseOpen(true)}
        onNewSearch={() => setShowSearch(true)}
        currentNovelTitle={novel?.title}
      />

      {showResumeToast && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[60] bg-indigo-600 text-white px-5 py-2.5 rounded-full shadow-2xl animate-fade-in-up text-sm font-bold flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
          已自動恢復上次閱讀進度
        </div>
      )}

      <main className="flex-1 container mx-auto px-4 md:px-6">
        <div className="max-w-4xl mx-auto pt-6 md:pt-10">
          
          {/* 只有在需要搜尋或尚未載入小說時顯示標題與輸入框 */}
          {(showSearch || !novel) && (
            <div className="animate-fade-in-up">
              <div className="text-center mb-6">
                <h1 className="text-3xl md:text-5xl font-extrabold mb-3 tracking-tight">
                  聆聽您最 <span className="text-indigo-500 italic">喜愛</span> 的小說。
                </h1>
              </div>

              <NovelInput onSearch={handleSearch} isLoading={state === ReaderState.FETCHING} />

              <div className="max-w-3xl mx-auto mt-8 p-6 bg-slate-800/30 rounded-2xl border border-slate-700/50">
                <p className="text-sm font-bold text-slate-400 mb-3 uppercase tracking-wider">或貼上文章內容（API 失敗時可用）</p>
                <textarea
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  placeholder="貼上網頁 HTML 或純文字，例如從小說網站複製的整段內容…"
                  className="w-full h-32 px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-xl text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 resize-y"
                />
                <button
                  type="button"
                  onClick={handleLoadPastedContent}
                  disabled={!pasteText.trim()}
                  className="mt-3 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold rounded-xl transition-all"
                >
                  載入並可朗讀
                </button>
              </div>

              {novel && (
                <div className="flex justify-center mb-8">
                  <button 
                    onClick={() => setShowSearch(false)}
                    className="text-xs font-bold text-indigo-400 hover:text-indigo-300 flex items-center gap-2 px-4 py-2 bg-indigo-500/10 rounded-full border border-indigo-500/20 transition-all"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
                    返回閱讀模式
                  </button>
                </div>
              )}
            </div>
          )}

          {error && <div className="max-w-xl mx-auto mb-6 p-4 bg-red-900/20 border border-red-500/30 rounded-xl text-red-400 text-sm text-center">{error}</div>}

          <div style={{ fontSize: `${fontSize}px` }}>
            <NovelDisplay novel={novel} isLoading={state === ReaderState.FETCHING} onNextChapter={handleNextChapter} />
          </div>
        </div>
      </main>

      {/* 固定底部播放列：高 z-index 確保在 iframe 內也看得見 */}
      <div className="fixed bottom-0 left-0 right-0 z-[100] flex flex-col gap-2 px-4 py-4 bg-slate-900/95 border-t border-white/10 backdrop-blur-md shadow-[0_-4px_24px_rgba(0,0,0,0.4)]">
        {/* 畫面上的除錯紀錄（不需開 Console） */}
        {debugLog.length > 0 && (
          <div className="rounded-lg bg-black/40 border border-amber-500/40 p-2 max-h-28 overflow-y-auto">
            <div className="flex items-center justify-between mb-1">
              <span className="text-amber-400 text-xs font-bold">除錯紀錄（按播放後會更新）</span>
              <button type="button" onClick={() => { setDebugLog([]); setDebugStep(null); }} className="text-slate-500 hover:text-white text-xs px-2">清除</button>
            </div>
            <div className="text-amber-200/90 text-xs font-mono space-y-0.5">
              {debugLog.map((line, i) => (
                <div key={i} className={line.includes('錯誤') ? 'text-red-400' : ''}>{line}</div>
              ))}
            </div>
          </div>
        )}
        {debugStep && (
          <div className="flex items-center justify-center gap-2 text-amber-400 text-xs font-mono">
            <span>目前: {debugStep}</span>
            <button type="button" onClick={() => setDebugStep(null)} className="text-slate-500 hover:text-white px-1" aria-label="關閉">×</button>
          </div>
        )}
        {error && (
          <div className="flex items-center justify-center gap-2 text-red-400 text-sm">
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)} className="text-slate-400 hover:text-white px-2" aria-label="關閉">×</button>
          </div>
        )}
        <div className="flex items-center justify-center gap-4">
          <span className="text-slate-400 text-sm font-medium truncate max-w-[120px] md:max-w-[200px]" title={novel?.title}>{novel?.title || '未選書'}</span>
          <button
            type="button"
            onClick={handlePlayPause}
            disabled={!canPlay || state === ReaderState.READING || state === ReaderState.FETCHING}
            className="flex-shrink-0 w-12 h-12 rounded-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center text-white shadow-lg transition-colors"
            title={state === ReaderState.FETCHING ? '正在取得內容…' : state === ReaderState.READING ? '正在產生語音…' : state === ReaderState.PLAYING ? '暫停' : '播放'}
          >
            {(state === ReaderState.READING || state === ReaderState.FETCHING) ? (
              <svg className="animate-spin" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 11-6.22-8.6" strokeLinecap="round"/></svg>
            ) : state === ReaderState.PLAYING ? (
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            )}
          </button>
          <button
            type="button"
            onClick={handleStop}
            className="flex-shrink-0 w-10 h-10 rounded-full bg-slate-700 hover:bg-slate-600 flex items-center justify-center text-slate-300 transition-colors"
            title="停止"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
          </button>
          <span className="text-slate-500 text-xs tabular-nums">
            {Math.floor(currentTime / 60)}:{(Math.floor(currentTime % 60)).toString().padStart(2, '0')}
            {duration > 0 && ` / ${Math.floor(duration / 60)}:${(Math.floor(duration % 60)).toString().padStart(2, '0')}`}
          </span>
        </div>
      </div>

      {/* Settings Modal */}
      {isSettingsOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-slate-900 border border-white/10 w-full max-w-md rounded-[2rem] p-8 shadow-2xl text-slate-100 animate-fade-in-up">
            <div className="flex justify-between items-center mb-8">
              <h2 className="text-2xl font-bold">閱讀偏好</h2>
              <button onClick={() => setIsSettingsOpen(false)} className="text-slate-400 hover:text-white"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
            </div>
            <div className="space-y-8">
              <div><label className="block text-sm font-bold text-slate-400 mb-3 uppercase tracking-widest">字體大小 ({fontSize}px)</label><input type="range" min="14" max="32" value={fontSize} onChange={(e) => setFontSize(parseInt(e.target.value))} className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-indigo-500" /></div>
              <div><label className="block text-sm font-bold text-slate-400 mb-4 uppercase tracking-widest">閱讀主題</label><div className="grid grid-cols-3 gap-3">{['dark', 'sepia', 'slate'].map(t => (<button key={t} onClick={() => setTheme(t as any)} className={`py-4 rounded-2xl border transition-all font-bold ${theme === t ? 'border-indigo-500 bg-indigo-500/10 text-white shadow-lg shadow-indigo-500/10' : 'border-white/5 bg-white/5 text-slate-500 hover:bg-white/10'}`}>{t === 'dark' ? '深邃黑' : t === 'sepia' ? '羊皮紙' : '岩板灰'}</button>))}</div></div>
            </div>
            <button onClick={() => setIsSettingsOpen(false)} className="w-full mt-10 py-5 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-2xl transition-all shadow-xl shadow-indigo-600/20">確認儲存</button>
          </div>
        </div>
      )}

      {/* Browse Modal */}
      {isBrowseOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-slate-900 border border-white/10 w-full max-w-2xl rounded-[2rem] p-8 shadow-2xl text-slate-100 animate-fade-in-up">
            <div className="flex justify-between items-center mb-8"><div><h2 className="text-2xl font-bold">瀏覽書源</h2><p className="text-slate-400 text-sm mt-1">開啟連結搜尋後，將網址貼回首頁輸入框。</p></div><button onClick={() => setIsBrowseOpen(false)} className="text-slate-400 hover:text-white"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button></div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {[ { name: '番茄小說', url: 'https://fanqienovel.com/', c: 'bg-orange-500' }, { name: '起點中文網', url: 'https://www.qidian.com/', c: 'bg-red-600' }, { name: '晉江文學城', url: 'https://www.jjwxc.net/', c: 'bg-green-600' }, { name: '縱橫中文網', url: 'https://www.zongheng.com/', c: 'bg-blue-600' } ].map(site => (
                <a key={site.name} href={site.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-4 p-5 bg-white/5 hover:bg-white/10 rounded-2xl border border-white/5 transition-all group">
                  <div className={`w-12 h-12 rounded-xl ${site.c} flex items-center justify-center text-white font-bold shadow-lg`}>{site.name[0]}</div>
                  <div><h3 className="font-bold group-hover:text-indigo-400 transition-colors">{site.name}</h3><p className="text-[10px] text-slate-500 font-bold tracking-widest uppercase">前往官方網站</p></div>
                </a>
              ))}
            </div>
          </div>
        </div>
      )}

      {theme === 'dark' && (<><div className="fixed -top-24 -left-24 w-96 h-96 bg-indigo-600/10 rounded-full blur-[100px] pointer-events-none -z-10"></div><div className="fixed bottom-0 right-0 w-[500px] h-[500px] bg-blue-600/5 rounded-full blur-[120px] pointer-events-none -z-10"></div></>)}
    </div>
  );
};

export default App;
