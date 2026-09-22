export const seasonalThemeCss = String.raw`
/* Seasonal/event presentation layer. Core control IDs, APIs and security behavior remain authoritative. */
.cc-seasonal-hero{position:relative;min-height:262px;margin:0 0 14px;border:1px solid color-mix(in srgb,var(--cc-season-accent,#f7c96b) 42%,var(--border));border-radius:18px;overflow:hidden;background:
radial-gradient(circle at 62% 30%,color-mix(in srgb,var(--cc-season-accent,#f7c96b) 42%,transparent) 0 5%,transparent 17%),
linear-gradient(115deg,color-mix(in srgb,var(--cc-season-deep,#07152c) 96%,transparent),color-mix(in srgb,var(--cc-season-mid,#112c52) 90%,transparent));
box-shadow:0 18px 48px rgba(0,0,0,.28);isolation:isolate}
.cc-seasonal-hero:before{content:"";position:absolute;inset:0;background:
linear-gradient(90deg,rgba(2,6,23,.9) 0%,rgba(2,6,23,.55) 42%,rgba(2,6,23,.08) 72%,rgba(2,6,23,.45) 100%),
radial-gradient(circle at 78% 36%,color-mix(in srgb,var(--cc-season-accent,#f7c96b) 20%,transparent),transparent 28%);z-index:-2}
.cc-seasonal-hero:after{content:"";position:absolute;inset:auto -3% -42% 25%;height:78%;background:
radial-gradient(ellipse at center,color-mix(in srgb,var(--cc-season-accent,#f7c96b) 20%,transparent),transparent 68%);filter:blur(14px);z-index:-1}
.cc-seasonal-sky{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:-1}
.cc-seasonal-orb{position:absolute;width:150px;height:150px;border-radius:50%;right:25%;top:18px;background:
radial-gradient(circle at 38% 34%,#fff9d4 0 5%,var(--cc-season-accent,#f7c96b) 32%,color-mix(in srgb,var(--cc-season-accent,#f7c96b) 62%,transparent) 63%,transparent 70%);
box-shadow:0 0 55px color-mix(in srgb,var(--cc-season-accent,#f7c96b) 52%,transparent);opacity:.95}
.cc-seasonal-horizon{position:absolute;left:28%;right:-2%;bottom:-6px;height:112px;background:
linear-gradient(to top,color-mix(in srgb,var(--cc-season-deep,#07152c) 96%,transparent),transparent),
radial-gradient(ellipse at 14% 100%,color-mix(in srgb,var(--cc-season-accent,#f7c96b) 16%,transparent) 0 12%,transparent 13%),
radial-gradient(ellipse at 35% 100%,rgba(1,8,20,.92) 0 24%,transparent 25%),
radial-gradient(ellipse at 63% 100%,rgba(1,8,20,.96) 0 29%,transparent 30%),
radial-gradient(ellipse at 88% 100%,rgba(1,8,20,.94) 0 34%,transparent 35%);opacity:.95}
.cc-seasonal-float{position:absolute;font-size:22px;filter:drop-shadow(0 3px 8px rgba(0,0,0,.45));animation:cc-season-float 6s ease-in-out infinite}
.cc-seasonal-float.f1{right:8%;top:28px}.cc-seasonal-float.f2{right:14%;top:94px;animation-delay:-2s}.cc-seasonal-float.f3{right:38%;top:32px;animation-delay:-4s}.cc-seasonal-float.f4{right:4%;bottom:22px;animation-delay:-1s}
@keyframes cc-season-float{0%,100%{transform:translateY(0) rotate(-2deg)}50%{transform:translateY(-9px) rotate(3deg)}}
.cc-seasonal-content{position:relative;display:grid;grid-template-columns:minmax(0,1.35fr) minmax(260px,.65fr);gap:26px;min-height:262px;padding:28px 30px;align-items:end}
.cc-seasonal-kicker{display:inline-flex;align-items:center;gap:8px;color:var(--cc-season-accent,#f7c96b);font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;margin-bottom:8px}
.cc-seasonal-title{margin:0;color:#fff;font-size:clamp(28px,4vw,48px);line-height:1.02;letter-spacing:-.035em;text-shadow:0 2px 18px rgba(0,0,0,.45)}
.cc-seasonal-subtitle{max-width:620px;margin:10px 0 0;color:#dbeafe;font-size:14px;line-height:1.55}
.cc-seasonal-quote{margin-top:16px;display:inline-flex;max-width:560px;padding:8px 12px;border-left:2px solid var(--cc-season-accent,#f7c96b);background:rgba(3,10,26,.28);backdrop-filter:blur(10px);color:#f8fafc;font-size:12.5px;font-style:italic;border-radius:0 8px 8px 0}
.cc-seasonal-side{display:grid;gap:10px;align-self:end}
.cc-seasonal-event-card{padding:13px 14px;border:1px solid color-mix(in srgb,var(--cc-season-accent,#f7c96b) 50%,transparent);border-radius:12px;background:rgba(3,10,26,.58);backdrop-filter:blur(14px);box-shadow:0 10px 30px rgba(0,0,0,.22)}
.cc-seasonal-event-head{display:flex;align-items:center;justify-content:space-between;gap:8px;color:#fff;font-weight:800;font-size:12px}
.cc-seasonal-event-head span:first-child{display:flex;align-items:center;gap:8px}.cc-seasonal-symbol{font-size:19px}
.cc-seasonal-countdown{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-top:9px}
.cc-seasonal-countdown div{padding:6px 4px;border-radius:7px;background:rgba(255,255,255,.055);text-align:center}.cc-seasonal-countdown b{display:block;color:#fff;font-size:18px;line-height:1}.cc-seasonal-countdown span{display:block;color:#aebfd6;margin-top:4px;font-size:8px;text-transform:uppercase;letter-spacing:.07em}
.cc-theme-chip{display:inline-flex;align-items:center;gap:6px;padding:5px 9px;border-radius:999px;border:1px solid color-mix(in srgb,var(--cc-season-accent,#f7c96b) 35%,transparent);background:color-mix(in srgb,var(--cc-season-accent,#f7c96b) 10%,transparent);color:var(--cc-season-accent,#f7c96b);font-size:10px;font-weight:800}
.cc-seasonal-settings{padding:16px 18px;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface);box-shadow:var(--shadow)}
.cc-seasonal-settings-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:12px}.cc-seasonal-settings h3{margin:0;color:var(--text-strong);font-size:16px}.cc-seasonal-settings p{margin:4px 0 0;color:var(--muted);font-size:12px}
.cc-seasonal-settings-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.cc-seasonal-settings label{margin:0}.cc-seasonal-settings select{margin-top:5px}
.cc-theme-preview{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:7px;margin-top:12px}.cc-theme-preview button{min-height:44px;padding:7px 8px;justify-content:flex-start;background:var(--surface-soft);font-size:11px}.cc-theme-preview button.active{border-color:var(--cc-season-accent,#f7c96b);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--cc-season-accent,#f7c96b) 25%,transparent);color:var(--cc-season-accent,#f7c96b)}
body[data-cc-theme]{--accent:var(--cc-season-ui-accent,#10b981);--accent-strong:var(--cc-season-ui-accent-strong,#059669);--cyan:var(--cc-season-accent,#38bdf8)}
body[data-cc-theme] .cc-layout{background:
radial-gradient(circle at 84% 4%,color-mix(in srgb,var(--cc-season-accent,#38bdf8) 10%,transparent),transparent 24%),
var(--bg0)}
body[data-cc-theme] .cc-sidebar{background:color-mix(in srgb,var(--surface) 91%,var(--cc-season-deep,#07152c));border-right-color:color-mix(in srgb,var(--cc-season-accent,#38bdf8) 18%,var(--border))}
body[data-cc-theme] .card,body[data-cc-theme] .metric,body[data-cc-theme] .exec-summary-card{backdrop-filter:blur(14px)}
body[data-cc-theme] .cc-section-card{background:color-mix(in srgb,var(--surface) 94%,var(--cc-season-deep,#07152c))}
body[data-cc-decor="minimal"] .cc-seasonal-float,body[data-cc-decor="minimal"] .cc-seasonal-horizon{display:none}
body[data-cc-decor="balanced"] .cc-seasonal-float.f3,body[data-cc-decor="balanced"] .cc-seasonal-float.f4{display:none}
body[data-cc-motion="off"] .cc-seasonal-float,body[data-cc-motion="reduced"] .cc-seasonal-float{animation:none}
@media(prefers-reduced-motion:reduce){.cc-seasonal-float{animation:none}}
@media(max-width:900px){.cc-seasonal-content{grid-template-columns:1fr;padding:24px}.cc-seasonal-side{max-width:460px}.cc-seasonal-orb{right:8%;opacity:.55}.cc-theme-preview{grid-template-columns:repeat(3,minmax(0,1fr))}.cc-seasonal-settings-grid{grid-template-columns:1fr}}
@media(max-width:620px){.cc-seasonal-hero{min-height:320px}.cc-seasonal-content{padding:20px;min-height:320px}.cc-seasonal-title{font-size:30px}.cc-seasonal-orb{width:118px;height:118px;top:18px;right:-12px}.cc-theme-preview{grid-template-columns:1fr 1fr}.cc-seasonal-countdown b{font-size:15px}}
`;

export const seasonalThemeScript = String.raw`
const CC_SEASON_MODE_KEY='rwmcp.appearance.season-mode.v1';
const CC_SEASON_THEME_KEY='rwmcp.appearance.season-theme.v1';
const CC_SEASON_MOTION_KEY='rwmcp.appearance.season-motion.v1';
const CC_SEASON_DECOR_KEY='rwmcp.appearance.season-decor.v1';

const CC_THEME_CATALOG={
 spring:{kind:'season',symbol:'🌸',vi:'Mùa Xuân',en:'Spring',tagVi:'Khởi đầu mới. Ý tưởng mới.',tagEn:'New beginnings. Brighter ideas.',quoteVi:'Mùa xuân là khởi đầu mới cho những điều tốt đẹp hơn.',quoteEn:'A new season for better ideas.',accent:'#f8a4c6',deep:'#091729',mid:'#173354',ui:'#10b981',uiStrong:'#059669',decor:['🌸','🌺','🏮','🌿']},
 summer:{kind:'season',symbol:'☀️',vi:'Mùa Hạ',en:'Summer',tagVi:'Năng lượng mới. Chân trời mới.',tagEn:'Brighter days. Greater ideas.',quoteVi:'Đi xa hơn với một mùa hè đầy năng lượng.',quoteEn:'Build more beyond borders.',accent:'#58d8ff',deep:'#061b34',mid:'#07588a',ui:'#06b6d4',uiStrong:'#0891b2',decor:['☀️','🌊','🪷','⛵']},
 autumn:{kind:'season',symbol:'🍂',vi:'Mùa Thu',en:'Autumn',tagVi:'Tập trung hơn. Sáng tạo hơn.',tagEn:'Cooler air. Clearer thoughts.',quoteVi:'Một nhịp chậm hơn để tạo ra những điều lớn hơn.',quoteEn:'A calmer mind builds greater things.',accent:'#f5a447',deep:'#1b0e09',mid:'#4a2111',ui:'#f59e0b',uiStrong:'#d97706',decor:['🍂','🏮','🌕','🍁']},
 winter:{kind:'season',symbol:'❄️',vi:'Mùa Đông',en:'Winter',tagVi:'Tĩnh lặng để kiến tạo.',tagEn:'Cold nights. Bright ideas.',quoteVi:'Trời lạnh, ý tưởng vẫn sáng.',quoteEn:'In the stillness, we build what comes next.',accent:'#8bc8ff',deep:'#071428',mid:'#153b67',ui:'#60a5fa',uiStrong:'#2563eb',decor:['❄️','✨','🌙','🏔️']},
 tet:{kind:'event',symbol:'🧧',vi:'Tết Nguyên Đán',en:'Vietnamese Lunar New Year',tagVi:'An Khang Thịnh Vượng · Vạn Sự Như Ý',tagEn:'New beginnings. Higher ideas.',quoteVi:'Tết là để trở về — và cũng là để bắt đầu.',quoteEn:'A new year, a new chapter to build.',accent:'#ffd166',deep:'#26060a',mid:'#71131b',ui:'#e63946',uiStrong:'#b91c1c',decor:['🏮','🌸','🧧','🎆']},
 'mid-autumn':{kind:'event',symbol:'🏮',vi:'Tết Trung Thu',en:'Mid-Autumn Festival',tagVi:'Trăng sáng kết nối muôn nơi',tagEn:'Same moon. Further possibilities.',quoteVi:'Đêm Trung Thu là để kết nối và yêu thương.',quoteEn:'Different places. Same moon. Greater ideas.',accent:'#ffd36a',deep:'#061329',mid:'#16315c',ui:'#d59b2d',uiStrong:'#a66f10',decor:['🏮','🌕','☁️','🦁']},
 'hung-kings':{kind:'event',symbol:'🥁',vi:'Giỗ Tổ Hùng Vương',en:'Hung Kings Commemoration',tagVi:'Hướng về cội nguồn · Vững bước tương lai',tagEn:'Honor the roots. Build the future.',quoteVi:'Uống nước nhớ nguồn. Cùng nhau kiến tạo tương lai.',quoteEn:'Remember the roots that shape tomorrow.',accent:'#e9b75f',deep:'#180b0d',mid:'#5b1719',ui:'#c68b3c',uiStrong:'#9a6322',decor:['🥁','🏛️','☁️','🔥']},
 'liberation-day':{kind:'event',symbol:'⭐',vi:'Ngày 30/4',en:'Reunification Day 30/4',tagVi:'Hòa bình tạo nền tảng · Công nghệ kiến tạo tương lai',tagEn:'Peace as foundation. Technology for tomorrow.',quoteVi:'Độc lập hôm qua. Kiến tạo ngày mai.',quoteEn:'History behind us. A future to engineer.',accent:'#ffd34d',deep:'#1d0608',mid:'#741217',ui:'#ef4444',uiStrong:'#b91c1c',decor:['🇻🇳','⭐','🎆','🕊️']},
 'labour-day':{kind:'event',symbol:'⚙️',vi:'Quốc tế Lao động 1/5',en:'International Labour Day',tagVi:'Đoàn kết · Sáng tạo · Kiến tạo tương lai',tagEn:'People build a better tomorrow.',quoteVi:'Tôn vinh người lao động và những giá trị được kiến tạo mỗi ngày.',quoteEn:'Every effort creates lasting value.',accent:'#ffbd59',deep:'#08152a',mid:'#263e5d',ui:'#f97316',uiStrong:'#c2410c',decor:['⚙️','🏗️','🛠️','🇻🇳']},
 'national-day':{kind:'event',symbol:'🇻🇳',vi:'Quốc Khánh 2/9',en:'Vietnam National Day',tagVi:'Tự hào dân tộc · Vững bước tương lai',tagEn:'Proud of the past. Building the future.',quoteVi:'Độc lập · Tự do · Hạnh phúc.',quoteEn:'Independence. Freedom. A future to build.',accent:'#ffd34d',deep:'#19070c',mid:'#65111b',ui:'#ef4444',uiStrong:'#b91c1c',decor:['🇻🇳','⭐','🎆','🏛️']},
 'womens-day':{kind:'event',symbol:'🌷',vi:'Ngày Quốc tế Phụ nữ 8/3',en:'International Women’s Day',tagVi:'Tôn vinh · Đồng hành · Tỏa sáng',tagEn:'Celebrate. Empower. Inspire.',quoteVi:'Tôn vinh những người phụ nữ luôn tạo nên khác biệt.',quoteEn:'Celebrating the women who make a difference.',accent:'#f59ac3',deep:'#1c0a20',mid:'#52204d',ui:'#ec4899',uiStrong:'#be185d',decor:['🌷','✨','🌸','💐']},
 'children-day':{kind:'event',symbol:'🎈',vi:'Quốc tế Thiếu nhi 1/6',en:'Children’s Day',tagVi:'Tò mò · Khám phá · Sáng tạo',tagEn:'Curiosity powers the future.',quoteVi:'Mọi ý tưởng lớn đều bắt đầu từ một câu hỏi nhỏ.',quoteEn:'Every great idea begins with curiosity.',accent:'#67e8f9',deep:'#071b2d',mid:'#155e75',ui:'#06b6d4',uiStrong:'#0e7490',decor:['🎈','🌈','⭐','🪁']},
 'family-day':{kind:'event',symbol:'🏡',vi:'Ngày Gia đình Việt Nam 28/6',en:'Vietnamese Family Day',tagVi:'Kết nối gần hơn · Đồng hành bền hơn',tagEn:'Closer connections. Stronger foundations.',quoteVi:'Công nghệ kết nối công việc, gia đình kết nối chúng ta.',quoteEn:'Technology connects work. Family connects us.',accent:'#f6c86c',deep:'#172016',mid:'#3c5b34',ui:'#84cc16',uiStrong:'#4d7c0f',decor:['🏡','❤️','🌿','✨']},
 'vietnam-women':{kind:'event',symbol:'🌺',vi:'Ngày Phụ nữ Việt Nam 20/10',en:'Vietnamese Women’s Day',tagVi:'Dịu dàng · Bản lĩnh · Tỏa sáng',tagEn:'Grace. Strength. Brilliance.',quoteVi:'Tôn vinh những người phụ nữ Việt Nam đầy bản lĩnh và sáng tạo.',quoteEn:'Celebrating Vietnamese women and their brilliance.',accent:'#fb9fba',deep:'#200a18',mid:'#662346',ui:'#f43f5e',uiStrong:'#be123c',decor:['🌺','🌸','✨','💐']},
 'teachers-day':{kind:'event',symbol:'📚',vi:'Ngày Nhà giáo Việt Nam 20/11',en:'Vietnamese Teachers’ Day',tagVi:'Tri thức dẫn đường · Sáng tạo tiếp bước',tagEn:'Knowledge lights the way.',quoteVi:'Biết ơn những người truyền cảm hứng cho hành trình học hỏi.',quoteEn:'Grateful to those who inspire the journey of learning.',accent:'#f5d06f',deep:'#0b1830',mid:'#253e63',ui:'#3b82f6',uiStrong:'#1d4ed8',decor:['📚','✨','🖋️','🌼']},
 'culture-day':{kind:'event',symbol:'🎭',vi:'Ngày Văn hóa Việt Nam 24/11',en:'Vietnam Culture Day',tagVi:'Bản sắc Việt · Sáng tạo mới',tagEn:'Vietnamese identity. New creativity.',quoteVi:'Giữ bản sắc để đi xa hơn trong một thế giới luôn đổi mới.',quoteEn:'Rooted in identity, ready for what comes next.',accent:'#e8b866',deep:'#1a0e13',mid:'#57222d',ui:'#d97706',uiStrong:'#92400e',decor:['🎭','🥁','☁️','🏮']}
};

const CC_LUNAR_EVENT_DATES={
 2026:{tet:'2026-02-17','hung-kings':'2026-04-26','mid-autumn':'2026-09-25'},
 2027:{tet:'2027-02-06','hung-kings':'2027-04-16','mid-autumn':'2027-09-15'},
 2028:{tet:'2028-01-26','hung-kings':'2028-04-04','mid-autumn':'2028-10-03'},
 2029:{tet:'2029-02-13','hung-kings':'2029-04-23','mid-autumn':'2029-09-22'},
 2030:{tet:'2030-02-03','hung-kings':'2030-04-12','mid-autumn':'2030-09-12'}
};

const CC_FIXED_EVENTS=[
 {id:'womens-day',month:3,day:8,before:2,after:1,priority:40},
 {id:'liberation-day',month:4,day:30,before:4,after:1,priority:80},
 {id:'labour-day',month:5,day:1,before:0,after:2,priority:79},
 {id:'children-day',month:6,day:1,before:2,after:1,priority:35},
 {id:'family-day',month:6,day:28,before:2,after:1,priority:34},
 {id:'national-day',month:9,day:2,before:5,after:2,priority:85},
 {id:'vietnam-women',month:10,day:20,before:2,after:1,priority:42},
 {id:'teachers-day',month:11,day:20,before:3,after:1,priority:42},
 {id:'culture-day',month:11,day:24,before:2,after:1,priority:38}
];

function ccYmdParts(date){
 const fmt=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Ho_Chi_Minh',year:'numeric',month:'2-digit',day:'2-digit'});
 const map={};for(const p of fmt.formatToParts(date)){if(p.type!=='literal')map[p.type]=p.value;}
 return {year:Number(map.year),month:Number(map.month),day:Number(map.day)};
}
function ccYmdString(p){return String(p.year).padStart(4,'0')+'-'+String(p.month).padStart(2,'0')+'-'+String(p.day).padStart(2,'0');}
function ccParseYmd(value){const a=value.split('-').map(Number);return {year:a[0],month:a[1],day:a[2]};}
function ccDayNumber(p){return Math.floor(Date.UTC(p.year,p.month-1,p.day)/86400000);}
function ccDaysFrom(nowParts,target){return ccDayNumber(target)-ccDayNumber(nowParts);}
function ccSeasonFor(parts){const m=parts.month;if(m>=2&&m<=4)return 'spring';if(m>=5&&m<=7)return 'summer';if(m>=8&&m<=10)return 'autumn';return 'winter';}
function ccResolveEvent(parts){
 const year=parts.year,candidates=[];
 const lunar=CC_LUNAR_EVENT_DATES[year]||{};
 const lunarSpecs=[
  {id:'tet',before:10,after:6,priority:100},
  {id:'hung-kings',before:4,after:1,priority:78},
  {id:'mid-autumn',before:7,after:2,priority:95}
 ];
 for(const spec of lunarSpecs){if(!lunar[spec.id])continue;const target=ccParseYmd(lunar[spec.id]);const delta=ccDaysFrom(parts,target);if(delta<=spec.before&&delta>=-spec.after)candidates.push({...spec,target,delta});}
 for(const spec of CC_FIXED_EVENTS){const target={year,month:spec.month,day:spec.day};const delta=ccDaysFrom(parts,target);if(delta<=spec.before&&delta>=-spec.after)candidates.push({...spec,target,delta});}
 candidates.sort((a,b)=>b.priority-a.priority||Math.abs(a.delta)-Math.abs(b.delta));return candidates[0]||null;
}
function ccReadSeasonSetting(key,fallback){try{return localStorage.getItem(key)||fallback;}catch{return fallback;}}
function ccWriteSeasonSetting(key,value){try{localStorage.setItem(key,value);}catch{}}
function ccResolveTheme(now=new Date()){
 const parts=ccYmdParts(now),mode=ccReadSeasonSetting(CC_SEASON_MODE_KEY,'event-first'),manual=ccReadSeasonSetting(CC_SEASON_THEME_KEY,'mid-autumn');
 const event=ccResolveEvent(parts),season=ccSeasonFor(parts);
 let id=season,target=null;
 if(mode==='manual'){id=CC_THEME_CATALOG[manual]?manual:season;}
 else if(mode==='seasonal'){id=season;}
 else if(mode==='event-first'&&event){id=event.id;target=event.target;}
 return {id,theme:CC_THEME_CATALOG[id]||CC_THEME_CATALOG.autumn,parts,event,target,mode};
}
function ccThemeCopy(theme){const vi=document.documentElement.lang==='vi';return {name:vi?theme.vi:theme.en,tag:vi?theme.tagVi:theme.tagEn,quote:vi?theme.quoteVi:theme.quoteEn};}
function ccThemeDays(target,parts){if(!target)return null;return Math.max(0,ccDaysFrom(parts,target));}
function ccCountdownHtml(days){
 if(days===null)return '';
 const d=String(days).padStart(2,'0');
 return '<div class="cc-seasonal-countdown"><div><b>'+d+'</b><span>days</span></div><div><b>00</b><span>hours</span></div><div><b>00</b><span>minutes</span></div><div><b>00</b><span>seconds</span></div></div>';
}
function ccRenderSeasonalHero(){
 const resolved=ccResolveTheme(),theme=resolved.theme,copy=ccThemeCopy(theme),overview=document.querySelector('.cc-page[data-page="overview"] .cc-page-grid');if(!overview)return;
 document.body.dataset.ccTheme=resolved.id;document.body.dataset.ccMotion=ccReadSeasonSetting(CC_SEASON_MOTION_KEY,'reduced');document.body.dataset.ccDecor=ccReadSeasonSetting(CC_SEASON_DECOR_KEY,'balanced');
 document.body.style.setProperty('--cc-season-accent',theme.accent);document.body.style.setProperty('--cc-season-deep',theme.deep);document.body.style.setProperty('--cc-season-mid',theme.mid);document.body.style.setProperty('--cc-season-ui-accent',theme.ui);document.body.style.setProperty('--cc-season-ui-accent-strong',theme.uiStrong);
 let hero=document.getElementById('ccSeasonalHero');if(!hero){hero=document.createElement('section');hero.id='ccSeasonalHero';hero.className='cc-seasonal-hero';overview.insertBefore(hero,overview.firstChild);}
 const decor=theme.decor||[];
 const eventDays=ccThemeDays(resolved.target,resolved.parts);
 hero.innerHTML='<div class="cc-seasonal-sky"><div class="cc-seasonal-orb"></div><div class="cc-seasonal-horizon"></div>'+
 decor.map((x,i)=>'<span class="cc-seasonal-float f'+(i+1)+'">'+x+'</span>').join('')+
 '</div><div class="cc-seasonal-content"><div><div class="cc-seasonal-kicker"><span>'+theme.symbol+'</span><span>'+copy.name+'</span></div><h1 class="cc-seasonal-title">'+copy.name+'</h1><p class="cc-seasonal-subtitle">'+copy.tag+'</p><div class="cc-seasonal-quote">“'+copy.quote+'”</div></div><div class="cc-seasonal-side"><div class="cc-seasonal-event-card"><div class="cc-seasonal-event-head"><span><span class="cc-seasonal-symbol">'+theme.symbol+'</span>'+copy.name+'</span><span class="cc-theme-chip">'+(resolved.mode==='manual'?'MANUAL':(theme.kind==='event'?'EVENT':'SEASON'))+'</span></div>'+ccCountdownHtml(eventDays)+'</div></div></div>';
}
function ccThemeOptions(){
 const groups=[['Season',['spring','summer','autumn','winter']],['Vietnam events',['tet','mid-autumn','hung-kings','liberation-day','labour-day','national-day','womens-day','children-day','family-day','vietnam-women','teachers-day','culture-day']]];
 return groups.map(g=>'<optgroup label="'+g[0]+'">'+g[1].map(id=>'<option value="'+id+'">'+CC_THEME_CATALOG[id].symbol+' '+CC_THEME_CATALOG[id].vi+' / '+CC_THEME_CATALOG[id].en+'</option>').join('')+'</optgroup>').join('');
}
function ccRenderSeasonalSettings(){
 const grid=document.querySelector('.cc-page[data-page="settings"] .cc-page-grid');if(!grid)return;
 let card=document.getElementById('ccSeasonalSettings');if(!card){card=document.createElement('section');card.id='ccSeasonalSettings';card.className='cc-seasonal-settings';grid.insertBefore(card,grid.firstChild);}
 const mode=ccReadSeasonSetting(CC_SEASON_MODE_KEY,'event-first'),manual=ccReadSeasonSetting(CC_SEASON_THEME_KEY,'mid-autumn'),motion=ccReadSeasonSetting(CC_SEASON_MOTION_KEY,'reduced'),decor=ccReadSeasonSetting(CC_SEASON_DECOR_KEY,'balanced');
 const vi=document.documentElement.lang==='vi';
 card.innerHTML='<div class="cc-seasonal-settings-head"><div><h3>'+(vi?'Giao diện theo mùa & sự kiện':'Seasonal & event appearance')+'</h3><p>'+(vi?'Ưu tiên sự kiện Việt Nam, sau đó tự trở về Xuân · Hạ · Thu · Đông.':'Vietnam events take priority, then fall back to Spring · Summer · Autumn · Winter.')+'</p></div><span class="cc-theme-chip">'+(CC_THEME_CATALOG[ccResolveTheme().id].symbol)+' '+ccResolveTheme().id+'</span></div>'+
 '<div class="cc-seasonal-settings-grid"><label>'+(vi?'Chế độ':'Mode')+'<select id="ccSeasonMode"><option value="event-first">Event first</option><option value="seasonal">Seasonal only</option><option value="manual">Manual</option></select></label><label>'+(vi?'Chủ đề thủ công':'Manual theme')+'<select id="ccSeasonManual">'+ccThemeOptions()+'</select></label><label>'+(vi?'Chuyển động':'Motion')+'<select id="ccSeasonMotion"><option value="reduced">Reduced</option><option value="full">Full</option><option value="off">Off</option></select></label><label>'+(vi?'Mật độ trang trí':'Decoration density')+'<select id="ccSeasonDecor"><option value="balanced">Balanced</option><option value="rich">Rich</option><option value="minimal">Minimal</option></select></label></div>'+
 '<div class="cc-theme-preview">'+['spring','summer','autumn','winter','tet','mid-autumn','hung-kings','liberation-day','labour-day','national-day'].map(id=>'<button type="button" data-cc-preview="'+id+'">'+CC_THEME_CATALOG[id].symbol+' '+(vi?CC_THEME_CATALOG[id].vi:CC_THEME_CATALOG[id].en)+'</button>').join('')+'</div>';
 const m=document.getElementById('ccSeasonMode'),t=document.getElementById('ccSeasonManual'),mo=document.getElementById('ccSeasonMotion'),de=document.getElementById('ccSeasonDecor');m.value=mode;t.value=manual;mo.value=motion;de.value=decor;
 const refresh=()=>{ccRenderSeasonalHero();ccRenderSeasonalSettings();};
 m.onchange=()=>{ccWriteSeasonSetting(CC_SEASON_MODE_KEY,m.value);refresh();};t.onchange=()=>{ccWriteSeasonSetting(CC_SEASON_THEME_KEY,t.value);if(m.value!=='manual'){ccWriteSeasonSetting(CC_SEASON_MODE_KEY,'manual');}refresh();};mo.onchange=()=>{ccWriteSeasonSetting(CC_SEASON_MOTION_KEY,mo.value);refresh();};de.onchange=()=>{ccWriteSeasonSetting(CC_SEASON_DECOR_KEY,de.value);refresh();};
 card.querySelectorAll('[data-cc-preview]').forEach(btn=>btn.onclick=()=>{ccWriteSeasonSetting(CC_SEASON_THEME_KEY,btn.dataset.ccPreview);ccWriteSeasonSetting(CC_SEASON_MODE_KEY,'manual');refresh();});
}
function initSeasonalThemeSystem(){
 ccRenderSeasonalHero();ccRenderSeasonalSettings();
 const obs=new MutationObserver(muts=>{if(muts.some(m=>m.type==='attributes'&&m.attributeName==='lang')){ccRenderSeasonalHero();ccRenderSeasonalSettings();}});obs.observe(document.documentElement,{attributes:true,attributeFilter:['lang']});
 setInterval(()=>ccRenderSeasonalHero(),60000);
}
`;
