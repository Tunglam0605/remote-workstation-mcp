import { getLanguage, onLanguageChange, registerTranslations, t } from './i18n.js';

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
  'Choose a theme to preview it on the dashboard. Your choice is stored in this browser.': 'Chọn một chủ đề để xem ngay trên dashboard. Lựa chọn được lưu riêng trên trình duyệt này.',
  'Seasonal & event themes': 'Sắc màu bốn mùa & sự kiện',
  'Unable to load the theme image. Please try again.': 'Không tải được ảnh chủ đề. Bạn thử lại nhé.',
  'Theme changed to {name}.': 'Đã chuyển sang giao diện {name}.',
  'Symbol {name}': 'Biểu tượng {name}',
  'MOONLIGHT EDITION · {name}': 'MOONLIGHT EDITION · {name}'
});

const localizedTheme = (theme) => Object.fromEntries(THEME_TEXT_FIELDS.map((field) => [field, t(ENGLISH_THEME_COPY[theme.id][field])]));

const KEY = 'moonlight-theme';
const pick = (id) => THEME_PACKS.find((theme) => theme.id === id) ?? THEME_PACKS[0];

export function createThemeController({ openModal, toast }) {
  const $ = (selector) => document.querySelector(selector);
  let current = THEME_PACKS[0];
  let generation = 0;
  const caption = document.createElement('div');
  caption.className = 'theme-caption'; caption.hidden = true;
  $('#countdown').after(caption);
  const control = document.createElement('button');
  control.type = 'button'; control.className = 'theme-launcher';
  control.id = 'theme-picker'; control.textContent = t('Theme · {name}', { name: localizedTheme(current).name });
  control.setAttribute('aria-label', t('Choose an event theme'));
  $('.sidebar nav').after(control);

  function show() {
    document.body.classList.remove('menu-open');
    $('#menu-toggle').setAttribute('aria-expanded', 'false');
    $('#scrim').hidden = true;
    const grid = document.createElement('div'); grid.className = 'theme-grid';
    for (const theme of THEME_PACKS) {
      const copy = localizedTheme(theme);
      const button = document.createElement('button'); button.type = 'button';
      button.className = 'theme-option'; button.dataset.themeId = theme.id;
      button.setAttribute('aria-pressed', String(current.id === theme.id));
      button.style.setProperty('--swatch', theme.accent);
      const img = document.createElement('img'); img.src = theme.background; img.alt = ''; img.loading = 'lazy';
      const label = document.createElement('strong'); label.textContent = copy.name;
      const detail = document.createElement('span'); detail.textContent = copy.description;
      button.append(img, label, detail);
      button.addEventListener('click', async () => {
        button.disabled = true;
        const applied = await apply(theme.id);
        if (applied) $('#modal').close();
        button.disabled = false;
      });
      grid.append(button);
    }
    const intro = document.createElement('p'); intro.className = 'theme-intro';
    intro.textContent = t('Choose a theme to preview it on the dashboard. Your choice is stored in this browser.');
    const content = document.createElement('div'); content.append(intro, grid);
    openModal(t('Seasonal & event themes'), content);
    $('#modal').classList.add('theme-dialog');
  }

  async function apply(id, { persist = true } = {}) {
    const theme = pick(id); const request = ++generation;
    if (theme.id !== 'mid-autumn') {
      try { const img = new Image(); img.src = theme.background; await img.decode(); }
      catch { if (request === generation) toast(t('Unable to load the theme image. Please try again.')); return false; }
    }
    if (request !== generation) return false;
    current = theme;
    render(theme);
    if (persist) {
      try { localStorage.setItem(KEY, theme.id); } catch {}
      const url = new URL(location.href); url.searchParams.set('theme', theme.id); history.replaceState(null, '', url);
      toast(t('Theme changed to {name}.', { name: localizedTheme(theme).name }));
    }
    return true;
  }

  function render(theme) {
    const copy = localizedTheme(theme);
    const root = document.documentElement;
    root.dataset.season = theme.id;
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
    const opening = document.createElement('span'); opening.className = 'quote-mark'; opening.textContent = '“'; side.append(opening);
    for (const [index, line] of copy.sidebar.split('\n').entries()) { if (index) side.append(document.createElement('br')); side.append(document.createTextNode(line)); }
    const closing = document.createElement('span'); closing.className = 'quote-end'; closing.textContent = '”'; side.append(closing);
    const countdown = theme.id === 'mid-autumn';
    $('#countdown').hidden = !countdown; caption.hidden = countdown;
    $('.countdown>div>p').textContent = countdown ? t('Mid-Autumn Festival') : copy.name;
    caption.textContent = copy.subtitle;
    $('.page-footer>span:last-child').textContent = t('MOONLIGHT EDITION · {name}', { name: copy.name.toLocaleUpperCase(getLanguage() === 'vi' ? 'vi-VN' : 'en-US') });
    control.textContent = t('Theme · {name}', { name: copy.name });
    control.setAttribute('aria-label', t('Choose an event theme'));
    const iconHolder = $('.season-icon'); iconHolder.replaceChildren();
    const icon = document.createElement('i'); icon.dataset.lucide = countdown ? 'flower' : theme.icon; iconHolder.append(icon);
    const seal = $('.moon-seal');
    const sealIcon = document.createElement('i'); sealIcon.dataset.lucide = countdown ? 'rabbit' : theme.icon;
    seal.replaceChildren(sealIcon);
    seal.setAttribute('role', 'img');
    seal.setAttribute('aria-label', t('Symbol {name}', { name: copy.name }));
    seal.title = copy.name;
    globalThis.lucide?.createIcons?.();
  }
  control.addEventListener('click', show);
  $('#appearance').setAttribute('aria-label', t('Choose an event theme'));
  $('#appearance').title = t('Choose an event theme');
  onLanguageChange(() => {
    render(current);
    const modal = $('#modal');
    if (modal.open && modal.classList.contains('theme-dialog')) show();
  });
  let saved; try { saved = localStorage.getItem(KEY); } catch {}
  const initial = new URL(location.href).searchParams.get('theme') || saved || 'mid-autumn';
  void apply(initial, { persist: false });
  return { show, apply, current: () => current };
}
