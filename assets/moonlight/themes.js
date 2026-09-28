import { getLanguage, onLanguageChange, registerTranslations, t } from './i18n.js';
import { CONTROL_CENTER_TIME_ZONE } from './time.js';

const asset = (id) => `/assets/moonlight/assets/backgrounds/${id}.png`;
export const THEME_PACKS = [
  { id: 'mid-autumn', name: 'Trung Thu', title: 'Trung Thu', greeting: 'Vui Tết Trung Thu', subtitle: 'Kết Nối Yêu Thương', motto: 'Chung một vầng trăng. Mở rộng những khả năng.', quote: 'Đêm Trung Thu\nlà để yêu thương.', sidebar: 'Trăng sáng\nkết nối muôn nơi\nCông nghệ đưa ta\nđến gần nhau hơn', description: 'Xanh đêm · vàng trăng', accent: '#ffd28a', panel: '18,35,57', base: '3,17,36', icon: 'moon', background: '/assets/moonlight/assets/mid-autumn.png' },
  { id: 'tet', name: 'Tết', title: 'Tết Đoàn Viên', greeting: 'Chúc Mừng Năm Mới', subtitle: 'An Khang · Hạnh Phúc', motto: 'Khởi đầu mới. Vạn điều như ý.', quote: 'Xuân về bên cửa\nấm một mái nhà.', sidebar: 'Mai vàng hé nụ\nđào hồng khoe sắc\nđón một mùa xuân\ntràn đầy hy vọng', description: 'Đỏ mai · vàng pháo hoa', accent: '#ffd080', panel: '47,24,38', base: '22,12,25', icon: 'sparkles' },
  { id: 'spring', name: 'Mùa Xuân', title: 'Sắc Xuân', greeting: 'Chào Một Mùa Xuân', subtitle: 'Những Khởi Đầu Dịu Dàng', motto: 'Mầm xanh nhỏ. Những ước mơ lớn.', quote: 'Một nhành hoa nở\nmột ngày bình yên.', sidebar: 'Hương xuân khe khẽ\nqua những tán cây\ncho bao ý tưởng\nnảy mầm hôm nay', description: 'Hồng đào · xanh ngọc', accent: '#ffc1d5', panel: '28,31,51', base: '11,19,35', icon: 'flower-2' },
  { id: 'summer', name: 'Mùa Hè', title: 'Hạ Rực Rỡ', greeting: 'Chào Mùa Hè Rực Rỡ', subtitle: 'Chạm Đến Chân Trời', motto: 'Nắng lên. Mở rộng những chân trời.', quote: 'Giữ một chút nắng\ncho ngày nhiều mây.', sidebar: 'Biển xanh rộng mở\nnắng chạm chân trời\nnhững điều mới mẻ\nđang đợi chúng ta', description: 'Xanh biển · vàng nắng', accent: '#84e9e1', panel: '10,42,52', base: '3,24,34', icon: 'sun' },
  { id: 'autumn', name: 'Mùa Thu', title: 'Thu Dịu Dàng', greeting: 'Chạm Ngõ Mùa Thu', subtitle: 'Chậm Lại Để Cảm Nhận', motto: 'Một khoảng lặng. Một ý tưởng mới.', quote: 'Thu về rất khẽ\nấm những bình yên.', sidebar: 'Lá vàng bên cửa\ngió nhẹ qua thềm\nchậm hơn một chút\nđể nghe mùa sang', description: 'Cam lá · hổ phách', accent: '#f5bb7f', panel: '41,31,31', base: '18,17,24', icon: 'leaf' },
  { id: 'winter', name: 'Mùa Đông', title: 'Đông An Yên', greeting: 'Ấm Áp Ngày Đông', subtitle: 'Giữ Lửa Những Kết Nối', motto: 'Ngoài trời se lạnh. Trong lòng ấm áp.', quote: 'Một ngọn đèn nhỏ\nấm cả mùa đông.', sidebar: 'Tuyết rơi ngoài cửa\nđèn sáng bên hiên\nkết nối còn đó\nấm những ngày đông', description: 'Xanh băng · bạc tuyết', accent: '#b8e6ff', panel: '24,37,57', base: '8,18,34', icon: 'snowflake' },
  { id: 'hung-kings', name: 'Giỗ Tổ Hùng Vương', title: 'Nhớ Cội Nguồn', greeting: 'Hướng Về Đất Tổ', subtitle: 'Uống Nước Nhớ Nguồn', motto: 'Tự hào cội nguồn. Tiếp bước tương lai.', quote: 'Một dòng nguồn cội\nmuôn nẻo đồng lòng.', sidebar: 'Dẫu đi muôn ngả\nvẫn nhớ quê nhà\nmột nguồn cội ấy\nnối những gần xa', description: 'Đồng cổ · vàng trầm', accent: '#efcc8f', panel: '36,32,32', base: '16,19,26', icon: 'landmark' },
  { id: 'reunification', name: '30/4 · Thống Nhất', title: 'Non Sông Một Dải', greeting: 'Mừng Ngày Thống Nhất', subtitle: 'Tự Hào Việt Nam', motto: 'Chung một đất nước. Cùng một tương lai.', quote: 'Bình yên hôm nay\nniềm tin ngày mới.', sidebar: 'Non sông liền dải\nbầu trời bình yên\ncùng nhau viết tiếp\nnhững ngày vươn lên', description: 'Đỏ cờ · vàng rạng đông', accent: '#ffd18d', panel: '40,26,39', base: '18,14,28', icon: 'flag' },
  { id: 'labour-day', name: '1/5 · Quốc Tế Lao Động', title: 'Dựng Xây Ngày Mai', greeting: 'Tôn Vinh Người Lao Động', subtitle: 'Sáng Tạo · Cống Hiến', motto: 'Từng việc nhỏ. Những giá trị lớn.', quote: 'Bàn tay sáng tạo\ndựng những ngày mai.', sidebar: 'Từ bao ý tưởng\nqua những bàn tay\nbền lòng sáng tạo\ndựng xây từng ngày', description: 'Xanh thép · vàng đồng', accent: '#f6ce86', panel: '20,37,47', base: '7,20,30', icon: 'hammer' },
  { id: 'national-day', name: '2/9 · Quốc Khánh', title: 'Việt Nam Rạng Rỡ', greeting: 'Mừng Quốc Khánh Việt Nam', subtitle: 'Độc Lập · Tự Do · Hạnh Phúc', motto: 'Tự hào hôm nay. Khát vọng ngày mai.', quote: 'Sắc cờ trong gió\nsáng những niềm tin.', sidebar: 'Cờ bay rực rỡ\ntrên những mái nhà\nchung niềm kiêu hãnh\nViệt Nam trong ta', description: 'Đỏ son · vàng sao', accent: '#ffcd83', panel: '45,23,36', base: '20,12,26', icon: 'star' }
].map((theme) => Object.freeze({ ...theme, background: theme.background ?? asset(theme.id) }));

const ENGLISH_THEME_COPY = Object.freeze({
  'mid-autumn': { name: 'Mid-Autumn', title: 'Mid-Autumn', greeting: 'Celebrate the Mid-Autumn Festival', subtitle: 'Connecting Hearts', motto: 'Same Moon. Further Possibilities.', quote: 'Mid-Autumn night\nis for love.', sidebar: 'Bright moonlight\nconnects every place\ntechnology brings us\ncloser together', description: 'Night blue · moon gold' },
  tet: { name: 'Tet', title: 'Reunion Tet', greeting: 'Happy New Year', subtitle: 'Prosperity · Happiness', motto: 'A fresh start. May every wish come true.', quote: 'Spring arrives at the door\nand warms a home.', sidebar: 'Yellow apricot blossoms\npink peach flowers\nwelcome a spring\nfilled with hope', description: 'Apricot red · fireworks gold' },
  spring: { name: 'Spring', title: 'Spring Hues', greeting: 'Welcome Spring', subtitle: 'Gentle New Beginnings', motto: 'Small green shoots. Big dreams.', quote: 'A blooming branch\na peaceful day.', sidebar: 'Spring fragrance drifts\nthrough the trees\nletting new ideas\ntake root today', description: 'Peach pink · jade green' },
  summer: { name: 'Summer', title: 'Radiant Summer', greeting: 'Welcome to a Radiant Summer', subtitle: 'Reach the Horizon', motto: 'Sunrise. Wider horizons.', quote: 'Keep a little sunshine\nfor cloudy days.', sidebar: 'The blue sea opens wide\nsunlight meets the horizon\nnew possibilities\nare waiting for us', description: 'Ocean blue · sunshine gold' },
  autumn: { name: 'Autumn', title: 'Gentle Autumn', greeting: 'Autumn Is at the Door', subtitle: 'Slow Down and Feel', motto: 'A quiet moment. A new idea.', quote: 'Autumn arrives softly\nand warms peaceful days.', sidebar: 'Golden leaves by the door\na soft breeze on the step\nslow down a little\nto hear the season change', description: 'Leaf orange · amber' },
  winter: { name: 'Winter', title: 'Peaceful Winter', greeting: 'Warm Winter Days', subtitle: 'Keep Connections Warm', motto: 'Cold outside. Warm within.', quote: 'A small lamp\nwarms the whole winter.', sidebar: 'Snow falls outside\na light shines on the porch\nconnections remain\nand warm winter days', description: 'Ice blue · snow silver' },
  'hung-kings': { name: 'Hung Kings Commemoration', title: 'Remembering Our Roots', greeting: 'Turning Toward the Ancestral Land', subtitle: 'When Drinking Water, Remember Its Source', motto: 'Proud of our roots. Moving toward the future.', quote: 'One shared source\nunites every path.', sidebar: 'Though we travel far\nwe remember home\nour shared roots\nconnect near and far', description: 'Ancient bronze · deep gold' },
  reunification: { name: '30 April · Reunification', title: 'One Continuous Homeland', greeting: 'Celebrate Reunification Day', subtitle: 'Proudly Vietnamese', motto: 'One country. One future.', quote: 'Today’s peace\nbrings faith in tomorrow.', sidebar: 'A continuous homeland\nbeneath peaceful skies\ntogether we write\nthe days ahead', description: 'Flag red · dawn gold' },
  'labour-day': { name: '1 May · International Workers’ Day', title: 'Building Tomorrow', greeting: 'Honouring Workers', subtitle: 'Creation · Dedication', motto: 'Every small task. Great value.', quote: 'Creative hands\nbuild tomorrow.', sidebar: 'From many ideas\nthrough working hands\nsteadfast creativity\nbuilds every day', description: 'Steel blue · bronze gold' },
  'national-day': { name: '2 September · National Day', title: 'Radiant Vietnam', greeting: 'Celebrate Vietnam’s National Day', subtitle: 'Independence · Freedom · Happiness', motto: 'Proud today. Aspiring for tomorrow.', quote: 'Flags in the wind\nbrighten every hope.', sidebar: 'Flags fly brightly\nover every home\nour shared pride\nis Vietnam within us', description: 'Crimson red · star gold' }
});

const THEME_TEXT_FIELDS = ['name', 'title', 'greeting', 'subtitle', 'motto', 'quote', 'sidebar', 'description'];
registerTranslations(Object.fromEntries(THEME_PACKS.flatMap((theme) =>
  THEME_TEXT_FIELDS.map((field) => [ENGLISH_THEME_COPY[theme.id][field], theme[field]]))));
registerTranslations({
  'Theme · {name}': 'Giao diện · {name}',
  'Choose an event theme': 'Chọn giao diện sự kiện',
  'Choose a theme to preview it for this tab. A new browser session returns to the automatic seasonal cycle.': 'Chọn một chủ đề để xem tạm trong tab này. Khi mở phiên trình duyệt mới, giao diện sẽ quay về chu trình mùa/sự kiện tự động.',
  'Seasonal & event themes': 'Sắc màu bốn mùa & sự kiện',
  'Automatic cycle · {name}': 'Tự động · {name}',
  'Use automatic seasonal cycle': 'Dùng chu trình mùa/sự kiện tự động',
  'Automatic seasonal cycle restored.': 'Đã quay về chu trình mùa/sự kiện tự động.',
  'Temporary preview · automatic mode resumes in a new browser session.': 'Xem tạm · phiên trình duyệt mới sẽ quay về chế độ tự động.',
  'Unable to load the theme image. Please try again.': 'Không tải được ảnh chủ đề. Bạn thử lại nhé.',
  'Theme changed to {name}.': 'Đã chuyển tạm sang giao diện {name}.',
  'Symbol {name}': 'Biểu tượng {name}',
  'MOONLIGHT EDITION · {name}': 'MOONLIGHT EDITION · {name}'
});

const localizedTheme = (theme) => Object.fromEntries(THEME_TEXT_FIELDS.map((field) => [field, t(ENGLISH_THEME_COPY[theme.id][field])]));
const pick = (id) => THEME_PACKS.find((theme) => theme.id === id) ?? THEME_PACKS.find((theme) => theme.id === 'autumn');
const SESSION_KEY = 'moonlight-theme-session';
const LEGACY_KEY = 'moonlight-theme';

const LUNAR_EVENT_DATES = Object.freeze({
  2026: { tet: '2026-02-17', 'hung-kings': '2026-04-26', 'mid-autumn': '2026-09-25' },
  2027: { tet: '2027-02-06', 'hung-kings': '2027-04-16', 'mid-autumn': '2027-09-15' },
  2028: { tet: '2028-01-26', 'hung-kings': '2028-04-04', 'mid-autumn': '2028-10-03' },
  2029: { tet: '2029-02-13', 'hung-kings': '2029-04-23', 'mid-autumn': '2029-09-22' },
  2030: { tet: '2030-02-03', 'hung-kings': '2030-04-12', 'mid-autumn': '2030-09-12' }
});

const LUNAR_EVENT_SPECS = Object.freeze([
  { id: 'tet', before: 5, after: 2, priority: 100 },
  { id: 'mid-autumn', before: 5, after: 1, priority: 95 },
  { id: 'hung-kings', before: 4, after: 1, priority: 80 }
]);

const FIXED_EVENT_SPECS = Object.freeze([
  { id: 'reunification', month: 4, day: 30, before: 5, after: 0, priority: 90 },
  { id: 'labour-day', month: 5, day: 1, before: 3, after: 1, priority: 85 },
  { id: 'national-day', month: 9, day: 2, before: 5, after: 1, priority: 95 }
]);

function ymdParts(date) {
  const parts = {};
  for (const part of new Intl.DateTimeFormat('en-CA', {
    timeZone: CONTROL_CENTER_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return { year: parts.year, month: parts.month, day: parts.day };
}

function parseYmd(value) {
  const [year, month, day] = String(value).split('-').map(Number);
  return { year, month, day };
}

function dayNumber(parts) {
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000);
}

function daysFrom(parts, target) {
  return dayNumber(target) - dayNumber(parts);
}

export function seasonForMonth(month) {
  if (month >= 2 && month <= 4) return 'spring';
  if (month >= 5 && month <= 7) return 'summer';
  if (month >= 8 && month <= 10) return 'autumn';
  return 'winter';
}

export function resolveAutomaticTheme(now = new Date()) {
  const parts = ymdParts(now);
  const candidates = [];
  const lunar = LUNAR_EVENT_DATES[parts.year] ?? {};
  for (const spec of LUNAR_EVENT_SPECS) {
    const raw = lunar[spec.id];
    if (!raw) continue;
    const target = parseYmd(raw);
    const delta = daysFrom(parts, target);
    if (delta <= spec.before && delta >= -spec.after) candidates.push({ ...spec, target, delta });
  }
  for (const spec of FIXED_EVENT_SPECS) {
    const target = { year: parts.year, month: spec.month, day: spec.day };
    const delta = daysFrom(parts, target);
    if (delta <= spec.before && delta >= -spec.after) candidates.push({ ...spec, target, delta });
  }
  candidates.sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta) || b.priority - a.priority);
  const event = candidates[0] ?? null;
  const season = seasonForMonth(parts.month);
  return {
    id: event?.id ?? season,
    season,
    event,
    target: event?.target ?? null,
    parts,
    mode: 'automatic'
  };
}

function targetTime(target) {
  if (!target) return null;
  const ymd = `${String(target.year).padStart(4, '0')}-${String(target.month).padStart(2, '0')}-${String(target.day).padStart(2, '0')}`;
  return Date.parse(`${ymd}T00:00:00+07:00`);
}

function countdownValues(target, now) {
  const timestamp = targetTime(target);
  if (!Number.isFinite(timestamp)) return [0, 0, 0, 0];
  const seconds = Math.max(0, Math.floor((timestamp - now.getTime()) / 1000));
  return [
    Math.floor(seconds / 86400),
    Math.floor(seconds % 86400 / 3600),
    Math.floor(seconds % 3600 / 60),
    seconds % 60
  ];
}

export function createThemeController({ openModal, toast }) {
  const $ = (selector) => document.querySelector(selector);
  let generation = 0;
  let automatic = resolveAutomaticTheme();
  let manualId = null;
  try {
    const stored = sessionStorage.getItem(SESSION_KEY);
    if (THEME_PACKS.some((theme) => theme.id === stored)) manualId = stored;
    localStorage.removeItem(LEGACY_KEY);
  } catch {}
  try {
    const url = new URL(location.href);
    if (url.searchParams.has('theme')) {
      url.searchParams.delete('theme');
      history.replaceState(null, '', url);
    }
  } catch {}

  let current = pick(manualId ?? automatic.id);
  let context = manualId
    ? { mode: 'manual', event: null, target: null, parts: automatic.parts }
    : automatic;

  const caption = document.createElement('div');
  caption.className = 'theme-caption';
  caption.hidden = true;
  $('#countdown').after(caption);

  const control = document.createElement('button');
  control.type = 'button';
  control.className = 'theme-launcher';
  control.id = 'theme-picker';
  control.textContent = t('Theme · {name}', { name: localizedTheme(current).name });
  control.setAttribute('aria-label', t('Choose an event theme'));
  $('.sidebar nav').after(control);

  function preload(theme) {
    if (typeof Image !== 'function') return Promise.resolve(true);
    const img = new Image();
    img.src = theme.background;
    return img.decode().then(() => true, () => false);
  }

  function updateCountdown(now = new Date()) {
    const activeTarget = context.mode === 'automatic' && context.event?.delta >= 0 ? context.target : null;
    if (!activeTarget) return;
    const values = countdownValues(activeTarget, now);
    document.querySelectorAll('#countdown b').forEach((node, index) => {
      node.textContent = String(values[index]).padStart(2, '0');
    });
  }

  function render(theme, nextContext = context) {
    context = nextContext;
    const copy = localizedTheme(theme);
    const root = document.documentElement;
    root.dataset.season = theme.id;
    root.dataset.themeMode = context.mode;
    root.style.setProperty('--gold', theme.accent);
    root.style.setProperty('--theme-panel', theme.panel);
    root.style.setProperty('--theme-base', theme.base);
    $('.landscape').style.backgroundImage = `url("${theme.background}")`;
    $('.hero').setAttribute('aria-label', copy.name);
    $('.season h2').textContent = copy.greeting;
    $('.season p').textContent = copy.motto;
    $('.festival-title h2').textContent = copy.title;
    $('.festival-title').classList.toggle('long-theme-title', copy.title.length > 15);
    $('.festival-title p').textContent = copy.subtitle;
    $('.stamp').hidden = theme.id !== 'mid-autumn';
    $('.festival-bottom blockquote').textContent = `“ ${copy.quote} ”`;

    const side = $('.sidebar blockquote');
    side.replaceChildren();
    const opening = document.createElement('span');
    opening.className = 'quote-mark';
    opening.textContent = '“';
    side.append(opening);
    for (const [index, line] of copy.sidebar.split('\n').entries()) {
      if (index) side.append(document.createElement('br'));
      side.append(document.createTextNode(line));
    }
    const closing = document.createElement('span');
    closing.className = 'quote-end';
    closing.textContent = '”';
    side.append(closing);

    const countdown = context.mode === 'automatic' && Boolean(context.event) && context.event.delta >= 0;
    $('#countdown').hidden = !countdown;
    caption.hidden = countdown;
    $('.countdown>div>p').textContent = copy.name;
    caption.textContent = context.mode === 'manual'
      ? t('Temporary preview · automatic mode resumes in a new browser session.')
      : copy.subtitle;

    $('.page-footer>span:last-child').textContent = t('MOONLIGHT EDITION · {name}', {
      name: copy.name.toLocaleUpperCase(getLanguage() === 'vi' ? 'vi-VN' : 'en-US')
    });
    control.textContent = t('Theme · {name}', { name: copy.name });
    control.setAttribute('aria-label', t('Choose an event theme'));

    const iconHolder = $('.season-icon');
    iconHolder.replaceChildren();
    const icon = document.createElement('i');
    icon.dataset.lucide = theme.icon;
    iconHolder.append(icon);

    const seal = $('.moon-seal');
    const sealIcon = document.createElement('i');
    sealIcon.dataset.lucide = theme.id === 'mid-autumn' ? 'rabbit' : theme.icon;
    seal.replaceChildren(sealIcon);
    seal.setAttribute('role', 'img');
    seal.setAttribute('aria-label', t('Symbol {name}', { name: copy.name }));
    seal.title = copy.name;

    root.dataset.themeReady = 'true';
    updateCountdown();
    globalThis.lucide?.createIcons?.();
  }

  async function apply(id, { manual = true, silent = false, nextContext = null } = {}) {
    const theme = pick(id);
    const request = ++generation;
    if (manual) {
      const loaded = await preload(theme);
      if (!loaded) {
        if (request === generation) toast(t('Unable to load the theme image. Please try again.'));
        return false;
      }
    }
    if (request !== generation) return false;
    current = theme;
    if (manual) {
      manualId = theme.id;
      try { sessionStorage.setItem(SESSION_KEY, theme.id); } catch {}
      render(theme, { mode: 'manual', event: null, target: null, parts: resolveAutomaticTheme().parts });
      if (!silent) toast(t('Theme changed to {name}.', { name: localizedTheme(theme).name }));
    } else {
      manualId = null;
      render(theme, nextContext ?? resolveAutomaticTheme());
    }
    return true;
  }

  async function useAutomatic({ silent = false } = {}) {
    try { sessionStorage.removeItem(SESSION_KEY); } catch {}
    automatic = resolveAutomaticTheme();
    await apply(automatic.id, { manual: false, silent: true, nextContext: automatic });
    if (!silent) toast(t('Automatic seasonal cycle restored.'));
  }

  function tick(now = new Date()) {
    if (manualId) return;
    const next = resolveAutomaticTheme(now);
    const targetChanged = JSON.stringify(next.target) !== JSON.stringify(context.target);
    if (next.id !== current.id || targetChanged || context.mode !== 'automatic') {
      automatic = next;
      current = pick(next.id);
      render(current, next);
    } else {
      context = next;
      updateCountdown(now);
    }
  }

  function show() {
    document.body.classList.remove('menu-open');
    $('#menu-toggle').setAttribute('aria-expanded', 'false');
    $('#scrim').hidden = true;

    const resolved = resolveAutomaticTheme();
    const content = document.createElement('div');
    const intro = document.createElement('p');
    intro.className = 'theme-intro';
    intro.textContent = t('Choose a theme to preview it for this tab. A new browser session returns to the automatic seasonal cycle.');

    const automaticButton = document.createElement('button');
    automaticButton.type = 'button';
    automaticButton.className = 'theme-auto-button';
    automaticButton.textContent = t('Automatic cycle · {name}', { name: localizedTheme(pick(resolved.id)).name });
    automaticButton.setAttribute('aria-pressed', String(!manualId));
    automaticButton.addEventListener('click', async () => {
      automaticButton.disabled = true;
      await useAutomatic();
      $('#modal').close();
    });

    const grid = document.createElement('div');
    grid.className = 'theme-grid';
    for (const theme of THEME_PACKS) {
      const copy = localizedTheme(theme);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'theme-option';
      button.dataset.themeId = theme.id;
      button.setAttribute('aria-pressed', String(Boolean(manualId) && current.id === theme.id));
      button.style.setProperty('--swatch', theme.accent);
      const img = document.createElement('img');
      img.src = theme.background;
      img.alt = '';
      img.loading = 'lazy';
      const label = document.createElement('strong');
      label.textContent = copy.name;
      const detail = document.createElement('span');
      detail.textContent = copy.description;
      button.append(img, label, detail);
      button.addEventListener('click', async () => {
        button.disabled = true;
        const applied = await apply(theme.id, { manual: true });
        if (applied) $('#modal').close();
        button.disabled = false;
      });
      grid.append(button);
    }

    content.append(intro, automaticButton, grid);
    openModal(t('Seasonal & event themes'), content);
    $('#modal').classList.add('theme-dialog');
  }

  control.addEventListener('click', show);
  $('#appearance').setAttribute('aria-label', t('Choose an event theme'));
  $('#appearance').title = t('Choose an event theme');
  onLanguageChange(() => {
    render(current, context);
    const modal = $('#modal');
    if (modal.open && modal.classList.contains('theme-dialog')) show();
  });

  render(current, context);
  tick();
  return { show, apply, useAutomatic, tick, current: () => current, automatic: () => automatic, mode: () => context.mode };
}
