export const seasonalThemeCss = String.raw`
/* Seasonal/event presentation layer. Core control IDs, APIs and security behavior remain authoritative. */

/* Base hero container with cinematic depth and Vietnamese luxury engineering cockpit styling */
.cc-seasonal-hero{
  position:relative;
  grid-column:1/-1;
  width:100%;
  min-height:280px;
  margin:0 0 18px;
  border:1px solid color-mix(in srgb,var(--cc-season-accent,#f7c96b) 44%,var(--border));
  border-radius:20px;
  overflow:hidden;
  background:
    radial-gradient(ellipse 80% 60% at 70% 20%,color-mix(in srgb,var(--cc-season-accent,#f7c96b) 32%,transparent) 0%,transparent 70%),
    radial-gradient(ellipse 65% 55% at 15% 85%,color-mix(in srgb,var(--cc-season-mid,#112c52) 48%,transparent) 0%,transparent 75%),
    linear-gradient(130deg,color-mix(in srgb,var(--cc-season-deep,#07152c) 98%,#020617) 0%,color-mix(in srgb,var(--cc-season-mid,#112c52) 88%,#020617) 55%,color-mix(in srgb,var(--cc-season-deep,#07152c) 98%,#020617) 100%);
  box-shadow:0 28px 68px -14px rgba(0,0,0,.72),0 0 0 1px rgba(255,255,255,.07) inset,0 1px 0 0 color-mix(in srgb,var(--cc-season-accent,#f7c96b) 50%,transparent) inset;
  isolation:isolate;
}

/* Atmospheric rim light, subtle cockpit grid vignette and depth layers */
.cc-seasonal-hero:before{
  content:"";
  position:absolute;
  inset:0;
  background:
    linear-gradient(90deg,rgba(2,6,23,.94) 0%,rgba(2,6,23,.72) 36%,rgba(2,6,23,.15) 68%,rgba(2,6,23,.6) 100%),
    radial-gradient(circle at 76% 32%,color-mix(in srgb,var(--cc-season-accent,#f7c96b) 24%,transparent),transparent 38%);
  z-index:-2;
}

.cc-seasonal-hero:after{
  content:"";
  position:absolute;
  inset:auto -5% -40% 20%;
  height:90%;
  background:radial-gradient(ellipse at center,color-mix(in srgb,var(--cc-season-accent,#f7c96b) 28%,transparent),transparent 68%);
  filter:blur(24px);
  z-index:-1;
}

/* Tasteful Vietnamese architectural frieze and decorative rail at the top */
.cc-seasonal-rail{
  position:absolute;
  top:0;
  left:0;
  right:0;
  height:3px;
  display:flex;
  align-items:center;
  justify-content:center;
  pointer-events:none;
  z-index:4;
  background:linear-gradient(90deg,transparent 0%,color-mix(in srgb,var(--cc-season-accent,#f7c96b) 22%,transparent) 12%,var(--cc-season-accent,#f7c96b) 50%,color-mix(in srgb,var(--cc-season-accent,#f7c96b) 22%,transparent) 88%,transparent 100%);
}
.cc-seasonal-rail:before,.cc-seasonal-rail:after{
  content:"";
  position:absolute;
  top:0;
  height:1px;
  width:28%;
  background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--cc-season-accent,#f7c96b) 60%,transparent));
}
.cc-seasonal-rail:before{left:18%}
.cc-seasonal-rail:after{right:18%;transform:scaleX(-1)}
.cc-seasonal-rail-diamond{
  display:inline-grid;
  place-items:center;
  width:15px;
  height:15px;
  border-radius:3px;
  transform:rotate(45deg);
  background:color-mix(in srgb,var(--cc-season-deep,#07152c) 94%,#000);
  border:1px solid var(--cc-season-accent,#f7c96b);
  color:var(--cc-season-accent,#f7c96b);
  font-size:8px;
  line-height:1;
  box-shadow:0 0 12px var(--cc-season-accent,#f7c96b),inset 0 0 4px color-mix(in srgb,var(--cc-season-accent,#f7c96b) 50%,transparent);
}

/* Sky layer: celestial orb, clouds, sparks, horizons */
.cc-seasonal-sky{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:-1}

/* Dong Son bronze drum celestial pattern */
.cc-seasonal-drum-motif{
  position:absolute;
  width:360px;
  height:360px;
  right:calc(24% - 94px);
  top:-94px;
  pointer-events:none;
  opacity:.26;
  color:var(--cc-season-accent,#f7c96b);
  transition:opacity .4s ease;
  animation:cc-season-drum-spin 140s linear infinite;
  filter:drop-shadow(0 0 16px color-mix(in srgb,var(--cc-season-accent,#f7c96b) 40%,transparent));
}
@keyframes cc-season-drum-spin{
  from{transform:rotate(0deg)}
  to{transform:rotate(360deg)}
}

/* Celestial orb with coronal ring */
.cc-seasonal-orb{
  position:absolute;
  width:172px;
  height:172px;
  border-radius:50%;
  right:24%;
  top:16px;
  background:radial-gradient(circle at 36% 34%,#ffffff 0%,#fff7dd 12%,var(--cc-season-accent,#f7c96b) 44%,color-mix(in srgb,var(--cc-season-accent,#f7c96b) 65%,var(--cc-season-mid,#112c52)) 72%,transparent 78%);
  box-shadow:
    0 0 54px color-mix(in srgb,var(--cc-season-accent,#f7c96b) 62%,transparent),
    0 0 110px color-mix(in srgb,var(--cc-season-accent,#f7c96b) 32%,transparent),
    inset -12px -12px 26px rgba(0,0,0,.4);
  opacity:.96;
  transition:transform .4s ease,background .4s ease,box-shadow .4s ease;
}
.cc-seasonal-orb-inner{
  position:absolute;
  inset:-16px;
  border-radius:50%;
  border:1px solid color-mix(in srgb,var(--cc-season-accent,#f7c96b) 40%,transparent);
  box-shadow:0 0 20px color-mix(in srgb,var(--cc-season-accent,#f7c96b) 25%,transparent);
  opacity:.75;
}
.cc-seasonal-orb-ring{
  position:absolute;
  inset:-28px;
  border-radius:50%;
  border:1px dashed color-mix(in srgb,var(--cc-season-accent,#f7c96b) 24%,transparent);
  opacity:.5;
}

/* Vietnamese stylized cloud motifs */
.cc-seasonal-clouds{position:absolute;inset:0;pointer-events:none;z-index:-1}
.cc-seasonal-cloud{
  position:absolute;
  border-radius:999px;
  background:radial-gradient(ellipse at center,color-mix(in srgb,var(--cc-season-accent,#f7c96b) 18%,transparent),transparent 72%);
  filter:blur(14px);
  opacity:.78;
}
.cc-seasonal-cloud.c1{
  width:310px;
  height:70px;
  right:16%;
  top:52px;
  animation:cc-season-drift 14s ease-in-out infinite alternate;
}
.cc-seasonal-cloud.c2{
  width:390px;
  height:80px;
  right:4%;
  bottom:35px;
  animation:cc-season-drift 18s ease-in-out infinite alternate-reverse;
}
@keyframes cc-season-drift{
  0%{transform:translateX(0) translateY(0)}
  100%{transform:translateX(24px) translateY(-6px)}
}

/* Celebratory fireworks / sparks motifs */
.cc-seasonal-sparks{position:absolute;inset:0;pointer-events:none;z-index:-1}
.cc-spark{
  position:absolute;
  width:4px;
  height:4px;
  border-radius:50%;
  background:#ffffff;
  box-shadow:0 0 10px 2px var(--cc-season-accent,#ffd166),0 0 20px 4px color-mix(in srgb,var(--cc-season-accent,#ffd166) 55%,transparent);
  animation:cc-season-sparkle 3.5s ease-in-out infinite;
}
.cc-spark.s1{right:28%;top:40px;animation-delay:0s}
.cc-spark.s2{right:12%;top:24px;animation-delay:-1.2s}
.cc-spark.s3{right:37%;top:115px;animation-delay:-2.4s}
.cc-spark.s4{right:6%;top:132px;animation-delay:-0.8s}
@keyframes cc-season-sparkle{
  0%,100%{opacity:.18;transform:scale(.7)}
  50%{opacity:1;transform:scale(1.4)}
}

/* Layered horizon silhouettes and atmospheric mist */
.cc-seasonal-horizon{
  position:absolute;
  left:0;
  right:0;
  bottom:0;
  height:125px;
  pointer-events:none;
  z-index:-1;
}
.cc-horizon-svg{width:100%;height:100%;display:block}
.cc-horizon-distant{
  fill:color-mix(in srgb,var(--cc-season-mid,#112c52) 40%,transparent);
  opacity:.45;
}
.cc-horizon-mid{
  fill:color-mix(in srgb,var(--cc-season-deep,#07152c) 75%,#010614);
  opacity:.75;
}
.cc-horizon-near{
  fill:color-mix(in srgb,var(--cc-season-deep,#07152c) 96%,#020617);
  opacity:.98;
}
.cc-seasonal-mist{
  position:absolute;
  left:-5%;
  right:-5%;
  bottom:0;
  height:90px;
  background:radial-gradient(ellipse 65% 100% at 50% 100%,color-mix(in srgb,var(--cc-season-accent,#f7c96b) 18%,transparent),transparent 75%);
  pointer-events:none;
  z-index:-1;
}

/* Floating cultural motifs with natural sway and luminous glow */
.cc-seasonal-float{
  position:absolute;
  font-size:26px;
  user-select:none;
  pointer-events:none;
  filter:drop-shadow(0 4px 14px rgba(0,0,0,.6)) drop-shadow(0 0 18px color-mix(in srgb,var(--cc-season-accent,#f7c96b) 50%,transparent));
  animation:cc-season-float 7.5s ease-in-out infinite;
  z-index:2;
}
.cc-seasonal-float.f1{right:9%;top:28px;font-size:28px}
.cc-seasonal-float.f2{right:16%;top:105px;font-size:24px;animation-delay:-2.4s}
.cc-seasonal-float.f3{right:39%;top:38px;font-size:25px;animation-delay:-4.8s}
.cc-seasonal-float.f4{right:5%;bottom:26px;font-size:22px;animation-delay:-1.4s}
@keyframes cc-season-float{
  0%,100%{transform:translateY(0) rotate(-3deg) scale(1)}
  50%{transform:translateY(-12px) rotate(5deg) scale(1.06)}
}

/* Artwork-backed presentation shared by approved seasonal/event themes. */
.cc-theme-artwork{
  min-height:318px;
  background-image:
    linear-gradient(90deg,rgba(2,8,23,.58) 0%,rgba(2,8,23,.18) 31%,rgba(2,8,23,.02) 66%,rgba(2,8,23,.18) 100%),
    linear-gradient(180deg,rgba(2,6,23,.01) 0%,rgba(2,6,23,.03) 58%,rgba(2,6,23,.60) 100%),
    var(--cc-season-artwork);
  background-size:cover;
  background-position:center center;
  border-color:color-mix(in srgb,var(--cc-season-accent,#f7c96b) 62%,transparent);
  box-shadow:0 30px 82px -18px rgba(0,0,0,.82),0 0 0 1px color-mix(in srgb,var(--cc-season-accent,#f7c96b) 18%,transparent) inset,0 0 48px color-mix(in srgb,var(--cc-season-accent,#f7c96b) 14%,transparent);
}
.cc-theme-artwork:before{background:linear-gradient(90deg,rgba(2,6,23,.42) 0%,rgba(2,6,23,.16) 30%,rgba(2,6,23,.01) 67%,rgba(2,6,23,.14) 100%)}
.cc-theme-artwork:after{background:linear-gradient(180deg,transparent 44%,rgba(2,6,23,.68) 100%);filter:none;height:100%;inset:0;z-index:-1}
.cc-theme-artwork .cc-seasonal-sky{opacity:.08}
.cc-theme-artwork .cc-seasonal-content{min-height:318px;padding:28px 28px 24px;align-items:end;grid-template-columns:minmax(0,1fr) minmax(300px,360px)}
.cc-theme-artwork .cc-seasonal-content>div:first-child{opacity:0;pointer-events:none;user-select:none}
.cc-theme-artwork .cc-seasonal-side{align-self:end;justify-self:end;width:min(360px,100%)}
.cc-theme-artwork .cc-seasonal-event-head{color:#fff8e6;text-shadow:0 2px 14px rgba(0,0,0,.72)}
.cc-theme-artwork .cc-seasonal-countdown{color:#fff}
.cc-theme-artwork .cc-seasonal-countdown b{color:#fff6cf;text-shadow:0 0 18px color-mix(in srgb,var(--cc-season-accent,#f7c96b) 28%,transparent)}
.cc-theme-artwork .cc-seasonal-event-card{
  background:linear-gradient(145deg,rgba(3,11,30,.90),rgba(7,25,52,.78));
  backdrop-filter:blur(18px) saturate(155%);
  -webkit-backdrop-filter:blur(18px) saturate(155%);
  border-color:color-mix(in srgb,var(--cc-season-accent,#f7c96b) 68%,transparent);
  box-shadow:0 18px 45px rgba(0,0,0,.48),0 0 34px color-mix(in srgb,var(--cc-season-accent,#f7c96b) 13%,transparent),inset 0 1px rgba(255,255,255,.16);
}
body[data-cc-artwork='1'] .cc-page[data-page='overview']{position:relative;background-image:linear-gradient(90deg,transparent 72%,rgba(2,8,23,.42)),var(--cc-season-rail-right);background-repeat:no-repeat;background-position:center,right bottom;background-size:auto,210px auto}
body[data-cc-artwork='1'] .cc-page[data-page='overview'] .cc-page-grid:before{
  content:'';position:fixed;inset:58px 0 0 220px;pointer-events:none;z-index:-1;opacity:.16;
  background:var(--cc-season-artwork) center top/cover fixed no-repeat;
  filter:saturate(1.16) contrast(1.04);
}
body[data-cc-artwork='1'] .card,
body[data-cc-artwork='1'] .metric,
body[data-cc-artwork='1'] .exec-summary-card{
  background:linear-gradient(145deg,rgba(5,17,38,.91),rgba(4,13,30,.84));
  backdrop-filter:blur(16px) saturate(145%);
  -webkit-backdrop-filter:blur(16px) saturate(145%);
  border-color:color-mix(in srgb,var(--cc-season-accent,#f7c96b) 20%,var(--border));
  box-shadow:0 12px 30px rgba(0,0,0,.28),inset 0 1px rgba(255,255,255,.035);
}
body[data-cc-artwork='1'] .cc-sidebar{
  background-image:linear-gradient(180deg,rgba(3,12,28,.97) 0%,rgba(3,13,30,.91) 45%,rgba(3,13,30,.54) 100%),var(--cc-season-rail-left);
  background-repeat:no-repeat;
  background-position:center,center bottom;
  background-size:auto,100% auto;
  border-right-color:color-mix(in srgb,var(--cc-season-accent,#f7c96b) 22%,var(--border));
  box-shadow:18px 0 55px rgba(0,0,0,.20);
}
body[data-cc-artwork='1'] .cc-workspace>.topbar{
  background:rgba(3,11,27,.84);
  border-bottom-color:color-mix(in srgb,var(--cc-season-accent,#f7c96b) 18%,var(--border));
  backdrop-filter:blur(18px) saturate(150%);
  -webkit-backdrop-filter:blur(18px) saturate(150%);
}
@media(max-width:900px){
  .cc-theme-artwork{min-height:260px;background-position:center center}
  .cc-theme-artwork .cc-seasonal-content{min-height:260px;padding:18px;grid-template-columns:1fr}
  .cc-theme-artwork .cc-seasonal-content>div:first-child{display:none}
  .cc-theme-artwork .cc-seasonal-side{width:min(420px,100%);justify-self:end}
  body[data-cc-artwork='1'] .cc-page[data-page='overview']{background-image:none}
  body[data-cc-artwork='1'] .cc-page[data-page='overview'] .cc-page-grid:before{inset:50px 0 0 0;opacity:.10}
  body[data-cc-artwork='1'] .cc-sidebar{background-image:linear-gradient(180deg,rgba(3,12,28,.98),rgba(3,13,30,.96))}
}
@media(max-width:620px){
  .cc-theme-artwork{min-height:230px}
  .cc-theme-artwork .cc-seasonal-content{min-height:230px;padding:14px}
  .cc-theme-artwork .cc-seasonal-event-card{padding:12px 14px}
}

/* Theme-specific tone refinements remain below. */
.cc-theme-tet .cc-seasonal-orb{
  background:radial-gradient(circle at 35% 32%,#fffbe6 0%,#ffd166 22%,#ea580c 58%,#b91c1c 82%,transparent 85%);
  box-shadow:0 0 54px rgba(255,209,102,.7),0 0 125px rgba(220,38,38,.42),inset -10px -10px 24px rgba(80,10,15,.5);
}
.cc-theme-tet .cc-seasonal-drum-motif{color:#ffd166;opacity:.36}
.cc-theme-tet .cc-spark{box-shadow:0 0 10px 2px #ffd166,0 0 20px 4px #dc2626}

/* Giỗ Tổ Hùng Vương */
.cc-theme-hung-kings .cc-seasonal-orb{
  background:radial-gradient(circle at 35% 32%,#fffbeb 0%,#fde68a 22%,#d97706 58%,#78350f 82%,transparent 85%);
  box-shadow:0 0 50px rgba(233,183,95,.65),0 0 120px rgba(180,83,9,.38),inset -10px -10px 22px rgba(50,20,5,.5);
}
.cc-theme-hung-kings .cc-seasonal-drum-motif{color:#e9b75f;opacity:.38}

/* Ngày 30/4 */
.cc-theme-liberation-day .cc-seasonal-orb{
  background:radial-gradient(circle at 35% 32%,#fffbe6 0%,#fde047 22%,#ea580c 58%,#991b1b 82%,transparent 85%);
  box-shadow:0 0 52px rgba(255,211,77,.68),0 0 120px rgba(220,38,38,.4),inset -10px -10px 24px rgba(80,10,15,.5);
}
.cc-theme-liberation-day .cc-seasonal-drum-motif{color:#ffd34d;opacity:.35}

/* Quốc tế Lao động 1/5 */
.cc-theme-labour-day .cc-seasonal-orb{
  background:radial-gradient(circle at 35% 32%,#ffffff 0%,#fef08a 18%,#f97316 56%,#9a3412 82%,transparent 85%);
  box-shadow:0 0 52px rgba(255,189,89,.62),0 0 120px rgba(249,115,22,.38),inset -10px -10px 22px rgba(70,20,5,.45);
}
.cc-theme-labour-day .cc-seasonal-drum-motif{color:#ffbd59;opacity:.32}

/* Quốc Khánh 2/9 */
.cc-theme-national-day .cc-seasonal-orb{
  background:radial-gradient(circle at 35% 32%,#fffbe6 0%,#fde047 22%,#dc2626 58%,#7f1d1d 82%,transparent 85%);
  box-shadow:0 0 56px rgba(255,211,77,.72),0 0 130px rgba(220,38,38,.45),inset -10px -10px 24px rgba(80,10,15,.5);
}
.cc-theme-national-day .cc-seasonal-drum-motif{color:#ffd34d;opacity:.4}
.cc-theme-national-day .cc-spark{box-shadow:0 0 10px 2px #ffd34d,0 0 20px 4px #dc2626}

/* 4 Seasons */
.cc-theme-spring .cc-seasonal-orb{
  background:radial-gradient(circle at 35% 32%,#ffffff 0%,#fce7f3 20%,#f472b6 55%,#9d174d 82%,transparent 85%);
  box-shadow:0 0 50px rgba(248,164,198,.6),0 0 110px rgba(244,114,182,.3),inset -10px -10px 22px rgba(80,10,40,.35);
}
.cc-theme-spring .cc-seasonal-drum-motif{color:#f8a4c6;opacity:.24}

.cc-theme-summer .cc-seasonal-orb{
  background:radial-gradient(circle at 35% 32%,#ffffff 0%,#cffafe 20%,#38bdf8 55%,#0369a1 82%,transparent 85%);
  box-shadow:0 0 54px rgba(88,216,255,.62),0 0 120px rgba(56,189,248,.35),inset -10px -10px 22px rgba(3,50,90,.4);
}
.cc-theme-summer .cc-seasonal-drum-motif{color:#58d8ff;opacity:.22}

.cc-theme-autumn .cc-seasonal-orb{
  background:radial-gradient(circle at 35% 32%,#fffdf2 0%,#fed7aa 20%,#f59e0b 55%,#9a3412 82%,transparent 85%);
  box-shadow:0 0 50px rgba(245,164,71,.62),0 0 110px rgba(217,119,6,.32),inset -10px -10px 22px rgba(70,25,0,.45);
}
.cc-theme-autumn .cc-seasonal-drum-motif{color:#f5a447;opacity:.26}

.cc-theme-winter .cc-seasonal-orb{
  background:radial-gradient(circle at 35% 32%,#ffffff 0%,#e0f2fe 20%,#60a5fa 58%,#1e3a8a 82%,transparent 85%);
  box-shadow:0 0 46px rgba(139,200,255,.55),0 0 105px rgba(96,165,250,.28),inset -10px -10px 22px rgba(15,30,80,.4);
}
.cc-theme-winter .cc-seasonal-drum-motif{color:#8bc8ff;opacity:.22}

/* Other Vietnam calendar events */
.cc-theme-womens-day .cc-seasonal-orb{
  background:radial-gradient(circle at 35% 32%,#ffffff 0%,#fdf2f8 20%,#ec4899 55%,#831843 82%,transparent 85%);
  box-shadow:0 0 48px rgba(245,154,195,.6),0 0 105px rgba(236,72,153,.3);
}
.cc-theme-womens-day .cc-seasonal-drum-motif{color:#f59ac3;opacity:.24}

.cc-theme-children-day .cc-seasonal-orb{
  background:radial-gradient(circle at 35% 32%,#ffffff 0%,#ecfeff 20%,#06b6d4 55%,#164e63 82%,transparent 85%);
  box-shadow:0 0 48px rgba(103,232,249,.6),0 0 105px rgba(6,182,212,.3);
}
.cc-theme-children-day .cc-seasonal-drum-motif{color:#67e8f9;opacity:.24}

.cc-theme-family-day .cc-seasonal-orb{
  background:radial-gradient(circle at 35% 32%,#ffffff 0%,#fefce8 20%,#84cc16 55%,#365314 82%,transparent 85%);
  box-shadow:0 0 48px rgba(246,200,108,.6),0 0 105px rgba(132,204,22,.3);
}
.cc-theme-family-day .cc-seasonal-drum-motif{color:#f6c86c;opacity:.24}

.cc-theme-vietnam-women .cc-seasonal-orb{
  background:radial-gradient(circle at 35% 32%,#ffffff 0%,#fff1f2 20%,#f43f5e 55%,#881337 82%,transparent 85%);
  box-shadow:0 0 48px rgba(251,159,186,.6),0 0 105px rgba(244,63,94,.3);
}
.cc-theme-vietnam-women .cc-seasonal-drum-motif{color:#fb9fba;opacity:.24}

.cc-theme-teachers-day .cc-seasonal-orb{
  background:radial-gradient(circle at 35% 32%,#ffffff 0%,#eff6ff 20%,#3b82f6 55%,#1e3a8a 82%,transparent 85%);
  box-shadow:0 0 48px rgba(245,208,111,.6),0 0 105px rgba(59,130,246,.3);
}
.cc-theme-teachers-day .cc-seasonal-drum-motif{color:#f5d06f;opacity:.24}

.cc-theme-culture-day .cc-seasonal-orb{
  background:radial-gradient(circle at 35% 32%,#fffbeb 0%,#fde68a 22%,#d97706 58%,#713f12 82%,transparent 85%);
  box-shadow:0 0 48px rgba(232,184,102,.6),0 0 105px rgba(217,119,6,.3);
}
.cc-theme-culture-day .cc-seasonal-drum-motif{color:#e8b866;opacity:.3}

/* Content grid */
.cc-seasonal-content{
  position:relative;
  display:grid;
  grid-template-columns:minmax(0,1.38fr) minmax(280px,.62fr);
  gap:28px;
  min-height:280px;
  padding:32px 34px;
  align-items:end;
}

/* Kicker pill */
.cc-seasonal-kicker{
  display:inline-flex;
  align-items:center;
  gap:8px;
  padding:5px 14px 5px 10px;
  border-radius:999px;
  background:color-mix(in srgb,var(--cc-season-accent,#f7c96b) 16%,rgba(3,10,26,.68));
  border:1px solid color-mix(in srgb,var(--cc-season-accent,#f7c96b) 42%,transparent);
  color:var(--cc-season-accent,#f7c96b);
  font-size:11.5px;
  font-weight:800;
  letter-spacing:.09em;
  text-transform:uppercase;
  margin-bottom:12px;
  backdrop-filter:blur(12px);
  -webkit-backdrop-filter:blur(12px);
  box-shadow:0 2px 12px rgba(0,0,0,.3);
}
.cc-seasonal-kicker-dot{
  width:7px;
  height:7px;
  border-radius:50%;
  background:currentColor;
  box-shadow:0 0 10px currentColor;
  animation:cc-season-dot-pulse 2.2s ease-in-out infinite;
}
@keyframes cc-season-dot-pulse{
  0%,100%{transform:scale(1);opacity:.85}
  50%{transform:scale(1.35);opacity:1;box-shadow:0 0 14px currentColor}
}

/* Cinematic typography */
.cc-seasonal-title{
  margin:0;
  color:#ffffff;
  font-size:clamp(32px,4.5vw,50px);
  line-height:1.05;
  letter-spacing:-.035em;
  font-weight:850;
  text-shadow:0 3px 26px rgba(0,0,0,.6),0 0 40px color-mix(in srgb,var(--cc-season-accent,#f7c96b) 30%,transparent);
}
.cc-seasonal-subtitle{
  max-width:640px;
  margin:10px 0 0;
  color:#f1f5f9;
  font-size:14.5px;
  line-height:1.6;
  text-shadow:0 1px 10px rgba(0,0,0,.65);
}
.cc-seasonal-quote{
  margin-top:16px;
  display:inline-flex;
  align-items:center;
  gap:10px;
  max-width:600px;
  padding:10px 16px;
  border-left:3.5px solid var(--cc-season-accent,#f7c96b);
  background:linear-gradient(90deg,color-mix(in srgb,var(--cc-season-accent,#f7c96b) 14%,rgba(3,10,26,.7)),rgba(3,10,26,.45));
  backdrop-filter:blur(16px);
  -webkit-backdrop-filter:blur(16px);
  color:#f8fafc;
  font-size:13px;
  font-style:italic;
  border-radius:0 12px 12px 0;
  border-top:1px solid rgba(255,255,255,.08);
  border-bottom:1px solid rgba(0,0,0,.3);
  box-shadow:0 8px 22px rgba(0,0,0,.26);
}

/* Right side glass event card */
.cc-seasonal-side{display:grid;gap:12px;align-self:end}
.cc-seasonal-event-card{
  position:relative;
  padding:18px 20px;
  border:1px solid color-mix(in srgb,var(--cc-season-accent,#f7c96b) 52%,rgba(255,255,255,.14));
  border-radius:16px;
  background:linear-gradient(145deg,rgba(255,255,255,.1) 0%,rgba(255,255,255,.02) 100%),rgba(3,10,24,.75);
  backdrop-filter:blur(22px) saturate(190%);
  -webkit-backdrop-filter:blur(22px) saturate(190%);
  box-shadow:
    0 22px 50px -12px rgba(0,0,0,.65),
    inset 0 1px 1px 0 rgba(255,255,255,.25),
    0 0 30px -8px color-mix(in srgb,var(--cc-season-accent,#f7c96b) 26%,transparent);
  overflow:hidden;
}
.cc-seasonal-event-card:before{
  content:"";
  position:absolute;
  top:0;
  left:0;
  right:0;
  height:1.5px;
  background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--cc-season-accent,#f7c96b) 75%,#fff),transparent);
}
.cc-seasonal-event-head{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:12px;
  color:#fff;
  font-weight:800;
  font-size:13px;
  letter-spacing:-.01em;
}
.cc-seasonal-event-head span:first-child{display:flex;align-items:center;gap:9px}
.cc-seasonal-symbol{font-size:22px;filter:drop-shadow(0 2px 8px rgba(0,0,0,.45))}

/* Live countdown presentation */
.cc-seasonal-countdown{display:grid;grid-template-columns:repeat(4,1fr);gap:9px;margin-top:13px}
.cc-seasonal-countdown div{
  padding:8px 6px;
  border-radius:9px;
  background:linear-gradient(180deg,rgba(255,255,255,.08) 0%,rgba(255,255,255,.025) 100%),rgba(2,6,18,.62);
  border:1px solid rgba(255,255,255,.1);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.15),0 4px 12px rgba(0,0,0,.3);
  text-align:center;
  transition:all .2s ease;
}
.cc-seasonal-countdown div:hover{
  border-color:color-mix(in srgb,var(--cc-season-accent,#f7c96b) 55%,rgba(255,255,255,.2));
  transform:translateY(-1px);
}
.cc-seasonal-countdown b{
  display:block;
  color:#ffffff;
  font-size:20px;
  line-height:1.05;
  font-family:ui-monospace,SFMono-Regular,Consolas,monospace;
  font-weight:850;
  letter-spacing:-.02em;
  text-shadow:0 0 14px color-mix(in srgb,var(--cc-season-accent,#f7c96b) 45%,transparent);
}
.cc-seasonal-countdown span{
  display:block;
  color:#94a3b8;
  margin-top:4px;
  font-size:9px;
  font-weight:800;
  text-transform:uppercase;
  letter-spacing:.09em;
}

/* Seasonal status card when countdown is not active */
.cc-seasonal-status-panel{
  margin-top:12px;
  padding:10px 12px;
  border-radius:10px;
  background:rgba(2,6,18,.5);
  border:1px solid rgba(255,255,255,.08);
}
.cc-seasonal-status-row{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:8px;
}
.cc-seasonal-status-badge{
  display:inline-flex;
  align-items:center;
  gap:6px;
  font-size:11px;
  font-weight:750;
  color:var(--cc-season-accent,#f7c96b);
}
.cc-status-pulse{
  width:6px;
  height:6px;
  border-radius:50%;
  background:currentColor;
  box-shadow:0 0 8px currentColor;
}
.cc-seasonal-phase-label{
  font-size:10px;
  color:var(--muted);
  text-transform:uppercase;
  letter-spacing:.05em;
  font-weight:700;
}
.cc-seasonal-status-desc{
  margin-top:6px;
  font-size:11.5px;
  color:#cbd5e1;
  line-height:1.45;
}

/* Theme chip badge */
.cc-theme-chip{
  display:inline-flex;
  align-items:center;
  gap:6px;
  padding:4px 10px;
  border-radius:999px;
  border:1px solid color-mix(in srgb,var(--cc-season-accent,#f7c96b) 40%,transparent);
  background:color-mix(in srgb,var(--cc-season-accent,#f7c96b) 14%,transparent);
  color:var(--cc-season-accent,#f7c96b);
  font-size:10px;
  font-weight:850;
  letter-spacing:.06em;
  text-transform:uppercase;
  box-shadow:0 0 12px color-mix(in srgb,var(--cc-season-accent,#f7c96b) 20%,transparent);
}

/* Settings card with clear operational controls */
.cc-seasonal-settings{
  padding:20px 22px;
  border:1px solid color-mix(in srgb,var(--border) 85%,var(--cc-season-accent,#f7c96b));
  border-radius:var(--radius);
  background:linear-gradient(180deg,color-mix(in srgb,var(--surface) 95%,var(--cc-season-mid,#112c52) 5%),var(--surface));
  box-shadow:var(--shadow);
  transition:border-color .22s ease;
}
.cc-seasonal-settings:hover{border-color:color-mix(in srgb,var(--cc-season-accent,#f7c96b) 45%,var(--border))}
.cc-seasonal-settings-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:16px}
.cc-seasonal-settings h3{margin:0;color:var(--text-strong);font-size:16.5px;font-weight:750;letter-spacing:-.015em}
.cc-seasonal-settings p{margin:4px 0 0;color:var(--muted);font-size:12.5px;line-height:1.5}
.cc-seasonal-settings-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}
.cc-seasonal-settings label{margin:0;font-size:11.5px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.cc-seasonal-settings select{margin-top:6px;width:100%;font-size:12.5px;font-weight:650}
.cc-theme-preview{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:9px;margin-top:16px}
.cc-theme-preview button{
  min-height:46px;
  padding:8px 11px;
  justify-content:flex-start;
  background:var(--surface-soft);
  border:1px solid var(--border-soft);
  border-radius:var(--radius-sm);
  font-size:12px;
  font-weight:650;
  transition:all .18s ease;
  cursor:pointer;
  display:inline-flex;
  align-items:center;
  gap:7px;
}
.cc-theme-preview button:hover{
  border-color:var(--cc-season-accent,#f7c96b);
  background:var(--surface-strong);
  transform:translateY(-2px);
  box-shadow:0 6px 16px rgba(0,0,0,.2);
}
.cc-theme-preview button.active{
  border-color:var(--cc-season-accent,#f7c96b);
  background:color-mix(in srgb,var(--cc-season-accent,#f7c96b) 16%,var(--surface-soft));
  box-shadow:0 0 18px -2px color-mix(in srgb,var(--cc-season-accent,#f7c96b) 32%,transparent),inset 0 0 0 1px color-mix(in srgb,var(--cc-season-accent,#f7c96b) 50%,transparent);
  color:var(--cc-season-accent,#f7c96b);
  font-weight:800;
}

/* Global dashboard shell ambiance while keeping operational clarity */
body[data-cc-theme]{
  --accent:var(--cc-season-ui-accent,#10b981);
  --accent-strong:var(--cc-season-ui-accent-strong,#059669);
  --cyan:var(--cc-season-accent,#38bdf8);
}
body[data-cc-theme] .cc-layout{
  background:
    radial-gradient(ellipse 1000px 500px at 85% 0%,color-mix(in srgb,var(--cc-season-accent,#38bdf8) 9%,transparent),transparent 72%),
    radial-gradient(ellipse 700px 350px at 15% 100%,color-mix(in srgb,var(--cc-season-deep,#07152c) 42%,transparent),transparent 72%),
    var(--bg0);
  background-attachment:fixed;
}
body[data-cc-theme] .cc-sidebar{
  background:color-mix(in srgb,var(--surface) 92%,var(--cc-season-deep,#07152c));
  border-right-color:color-mix(in srgb,var(--cc-season-accent,#38bdf8) 20%,var(--border));
}
body[data-cc-theme] .card,
body[data-cc-theme] .metric,
body[data-cc-theme] .exec-summary-card{
  backdrop-filter:blur(14px);
  -webkit-backdrop-filter:blur(14px);
}
body[data-cc-theme] .cc-section-card{
  background:color-mix(in srgb,var(--surface) 93%,var(--cc-season-deep,#07152c));
}
body[data-cc-theme] .metric:hover{
  border-color:color-mix(in srgb,var(--cc-season-accent,#38bdf8) 60%,var(--border));
}

/* Decoration density rules */
body[data-cc-decor="minimal"] .cc-seasonal-float,
body[data-cc-decor="minimal"] .cc-seasonal-horizon,
body[data-cc-decor="minimal"] .cc-seasonal-clouds,
body[data-cc-decor="minimal"] .cc-seasonal-sparks,
body[data-cc-decor="minimal"] .cc-seasonal-mist,
body[data-cc-decor="minimal"] .cc-seasonal-drum-motif{display:none}

body[data-cc-decor="balanced"] .cc-seasonal-float.f3,
body[data-cc-decor="balanced"] .cc-seasonal-float.f4,
body[data-cc-decor="balanced"] .cc-spark.s3,
body[data-cc-decor="balanced"] .cc-spark.s4{display:none}

/* Motion accessibility */
body[data-cc-motion="off"] .cc-seasonal-float,
body[data-cc-motion="off"] .cc-seasonal-cloud,
body[data-cc-motion="off"] .cc-spark,
body[data-cc-motion="off"] .cc-seasonal-kicker-dot,
body[data-cc-motion="off"] .cc-seasonal-drum-motif{animation:none!important}

body[data-cc-motion="reduced"] .cc-seasonal-float,
body[data-cc-motion="reduced"] .cc-seasonal-cloud,
body[data-cc-motion="reduced"] .cc-spark,
body[data-cc-motion="reduced"] .cc-seasonal-drum-motif{animation-duration:0.01ms!important;animation-iteration-count:1!important}

@media(prefers-reduced-motion:reduce){
  .cc-seasonal-float,.cc-seasonal-cloud,.cc-spark,.cc-seasonal-drum-motif,.cc-seasonal-kicker-dot{animation:none!important}
}

/* Responsive adjustments */
@media(max-width:1080px){
  .cc-seasonal-settings-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .cc-theme-preview{grid-template-columns:repeat(5,minmax(0,1fr))}
}
@media(max-width:900px){
  .cc-seasonal-content{grid-template-columns:1fr;padding:24px}
  .cc-seasonal-side{max-width:480px;width:100%}
  .cc-seasonal-orb{right:8%;top:20px;opacity:.7}
  .cc-seasonal-drum-motif{right:calc(8% - 90px);top:-80px;opacity:.2}
  .cc-theme-preview{grid-template-columns:repeat(3,minmax(0,1fr))}
  .cc-seasonal-settings-grid{grid-template-columns:1fr}
}
@media(max-width:620px){
  .cc-seasonal-hero{min-height:340px}
  .cc-seasonal-content{padding:20px 16px;min-height:340px}
  .cc-seasonal-title{font-size:28px}
  .cc-seasonal-subtitle{font-size:13px}
  .cc-seasonal-orb{width:120px;height:120px;top:16px;right:-10px;opacity:.55}
  .cc-seasonal-drum-motif{width:260px;height:260px;top:-60px;right:-50px;opacity:.15}
  .cc-theme-preview{grid-template-columns:1fr 1fr}
  .cc-seasonal-countdown b{font-size:16px}
  .cc-seasonal-quote{font-size:12px;padding:8px 12px}
  .cc-seasonal-float.f2,.cc-seasonal-float.f3{display:none}
}
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

const CC_ARTWORK_THEME_IDS=new Set(['spring','summer','autumn','winter','tet','mid-autumn','hung-kings','liberation-day','labour-day','national-day']);

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
 try{if(typeof location!=='undefined'&&new URLSearchParams(location.search).get('preview')==='mid-autumn'){const lunar=CC_LUNAR_EVENT_DATES[parts.year]||{};return {id:'mid-autumn',theme:CC_THEME_CATALOG['mid-autumn'],parts,event:{id:'mid-autumn'},target:lunar['mid-autumn']?ccParseYmd(lunar['mid-autumn']):null,mode:'manual'};}}catch{}
 const event=ccResolveEvent(parts),season=ccSeasonFor(parts);
 let id=season,target=null;
 if(mode==='manual'){id=CC_THEME_CATALOG[manual]?manual:season;}
 else if(mode==='seasonal'){id=season;}
 else if(mode==='event-first'&&event){id=event.id;target=event.target;}
 return {id,theme:CC_THEME_CATALOG[id]||CC_THEME_CATALOG.autumn,parts,event,target,mode};
}
function ccThemeCopy(theme){const vi=typeof document!=='undefined'&&document.documentElement&&document.documentElement.lang==='vi';return {name:vi?theme.vi:theme.en,tag:vi?theme.tagVi:theme.tagEn,quote:vi?theme.quoteVi:theme.quoteEn};}
function ccThemeDays(target,parts){if(!target)return null;return Math.max(0,ccDaysFrom(parts,target));}

function ccRemainingTime(target,now=new Date()){
 if(!target)return null;
 const targetMs=Date.UTC(target.year,target.month-1,target.day)-7*3600000;
 const diff=targetMs-now.getTime();
 if(diff<=0)return {days:0,hours:0,minutes:0,seconds:0,today:true};
 const totalSec=Math.floor(diff/1000);
 return {
  days:Math.floor(totalSec/86400),
  hours:Math.floor((totalSec%86400)/3600),
  minutes:Math.floor((totalSec%3600)/60),
  seconds:totalSec%60,
  today:false
 };
}

function ccCountdownHtml(days,target,copy){
 const vi=typeof document!=='undefined'&&document.documentElement&&document.documentElement.lang==='vi';
 if(days===null||!target){
  return '<div class="cc-seasonal-status-panel">'+
   '<div class="cc-seasonal-status-row">'+
    '<span class="cc-seasonal-status-badge"><span class="cc-status-pulse"></span>'+(vi?'Mùa đang kích hoạt':'Active Season')+'</span>'+
    '<span class="cc-seasonal-phase-label">'+(vi?'Không gian điều hành':'Console Ambiance')+'</span>'+
   '</div>'+
   '<div class="cc-seasonal-status-desc">'+(copy?copy.tag:'')+'</div>'+
  '</div>';
 }
 const rem=target?ccRemainingTime(target):null;
 const d=String(rem?rem.days:days).padStart(2,'0');
 const h=String(rem?rem.hours:0).padStart(2,'0');
 const m=String(rem?rem.minutes:0).padStart(2,'0');
 const s=String(rem?rem.seconds:0).padStart(2,'0');
 const isToday=rem&&rem.today;
 return '<div class="cc-seasonal-countdown" id="ccSeasonalCountdown" data-target="'+ccYmdString(target)+'">'+
  '<div><b data-cd="d">'+d+'</b><span>'+(vi?'ngày':'days')+'</span></div>'+
  '<div><b data-cd="h">'+h+'</b><span>'+(vi?'giờ':'hours')+'</span></div>'+
  '<div><b data-cd="m">'+m+'</b><span>'+(vi?'phút':'minutes')+'</span></div>'+
  '<div><b data-cd="s">'+s+'</b><span>'+(vi?'giây':'seconds')+'</span></div>'+
 '</div>'+
 (isToday?'<div class="cc-seasonal-status-panel" style="margin-top:8px"><div class="cc-seasonal-status-badge"><span class="cc-status-pulse"></span>'+(vi?'🎉 Đang diễn ra hôm nay!':'🎉 Celebrating today!')+'</div></div>':'');
}

function ccTickCountdown(){
 const root=typeof document!=='undefined'&&document.getElementById('ccSeasonalCountdown');
 if(!root||!root.dataset.target)return;
 const target=ccParseYmd(root.dataset.target);
 const rem=ccRemainingTime(target);
 if(!rem)return;
 const d=root.querySelector('[data-cd="d"]');
 const h=root.querySelector('[data-cd="h"]');
 const m=root.querySelector('[data-cd="m"]');
 const s=root.querySelector('[data-cd="s"]');
 if(d)d.textContent=String(rem.days).padStart(2,'0');
 if(h)h.textContent=String(rem.hours).padStart(2,'0');
 if(m)m.textContent=String(rem.minutes).padStart(2,'0');
 if(s)s.textContent=String(rem.seconds).padStart(2,'0');
}

function ccRenderSeasonalHero(){
 if(typeof document==='undefined')return;
 const resolved=ccResolveTheme(),theme=resolved.theme,copy=ccThemeCopy(theme),overview=document.querySelector('.cc-page[data-page="overview"] .cc-page-grid'),hasArtwork=CC_ARTWORK_THEME_IDS.has(resolved.id);
 if(!overview)return;
 document.body.dataset.ccTheme=resolved.id;
 document.body.dataset.ccArtwork=hasArtwork?'1':'0';
 if(hasArtwork){
  const base='/assets/themes/'+resolved.id;
  document.body.style.setProperty('--cc-season-artwork',"url('"+base+"/hero.webp')");
  document.body.style.setProperty('--cc-season-rail-left',"url('"+base+"/rail-left.webp')");
  document.body.style.setProperty('--cc-season-rail-right',"url('"+base+"/rail-right.webp')");
 }else{
  document.body.style.removeProperty('--cc-season-artwork');
  document.body.style.removeProperty('--cc-season-rail-left');
  document.body.style.removeProperty('--cc-season-rail-right');
 }
 document.body.dataset.ccMotion=ccReadSeasonSetting(CC_SEASON_MOTION_KEY,'reduced');
 document.body.dataset.ccDecor=ccReadSeasonSetting(CC_SEASON_DECOR_KEY,'balanced');
 document.body.style.setProperty('--cc-season-accent',theme.accent);
 document.body.style.setProperty('--cc-season-deep',theme.deep);
 document.body.style.setProperty('--cc-season-mid',theme.mid);
 document.body.style.setProperty('--cc-season-ui-accent',theme.ui);
 document.body.style.setProperty('--cc-season-ui-accent-strong',theme.uiStrong);
 let hero=document.getElementById('ccSeasonalHero');
 if(!hero){
  hero=document.createElement('section');
  hero.id='ccSeasonalHero';
  overview.insertBefore(hero,overview.firstChild);
 }
 hero.className='cc-seasonal-hero cc-theme-'+resolved.id+(hasArtwork?' cc-theme-artwork':'');
 const decor=theme.decor||[];
 const eventDays=ccThemeDays(resolved.target,resolved.parts);
 const vi=document.documentElement.lang==='vi';
 const modeBadge=resolved.mode==='manual'?(vi?'THỦ CÔNG':'MANUAL'):(theme.kind==='event'?(vi?'SỰ KIỆN':'EVENT'):(vi?'MÙA':'SEASON'));
 hero.innerHTML=
  '<div class="cc-seasonal-rail" aria-hidden="true"><span class="cc-seasonal-rail-diamond">❖</span></div>'+
  '<div class="cc-seasonal-sky">'+
   '<svg class="cc-seasonal-drum-motif" viewBox="0 0 200 200" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">'+
    '<circle cx="100" cy="100" r="92" stroke-dasharray="2 3" opacity="0.45"/>'+
    '<circle cx="100" cy="100" r="82" stroke-width="1" opacity="0.6"/>'+
    '<circle cx="100" cy="100" r="70" stroke-dasharray="4 2" stroke-width="1.4" opacity="0.75"/>'+
    '<circle cx="100" cy="100" r="54" stroke-width="1" opacity="0.6"/>'+
    '<polygon points="100,68 103,90 122,78 111,94 131,92 114,103 128,118 109,112 114,131 99,115 88,131 91,111 72,119 86,104 69,92 89,94 78,78 97,90" fill="currentColor" fill-opacity="0.22" stroke="currentColor" stroke-width="1.2"/>'+
    '<circle cx="100" cy="100" r="8" fill="currentColor" fill-opacity="0.6"/>'+
   '</svg>'+
   '<div class="cc-seasonal-orb"><div class="cc-seasonal-orb-inner"></div><div class="cc-seasonal-orb-ring"></div></div>'+
   '<div class="cc-seasonal-clouds" aria-hidden="true"><div class="cc-seasonal-cloud c1"></div><div class="cc-seasonal-cloud c2"></div></div>'+
   '<div class="cc-seasonal-sparks" aria-hidden="true"><span class="cc-spark s1"></span><span class="cc-spark s2"></span><span class="cc-spark s3"></span><span class="cc-spark s4"></span></div>'+
   '<div class="cc-seasonal-horizon" aria-hidden="true">'+
    '<svg viewBox="0 0 1200 120" preserveAspectRatio="none" class="cc-horizon-svg">'+
     '<path d="M0,120 L0,72 Q120,40 240,65 Q380,30 520,70 Q660,35 800,60 Q960,25 1100,55 Q1160,65 1200,60 L1200,120 Z" class="cc-horizon-distant"/>'+
     '<path d="M0,120 L0,84 Q140,55 300,82 Q440,48 580,78 Q720,52 880,82 Q1020,50 1200,75 L1200,120 Z" class="cc-horizon-mid"/>'+
     '<path d="M0,120 L0,96 Q160,82 340,98 Q500,80 680,95 Q860,78 1040,94 Q1140,88 1200,92 L1200,120 Z" class="cc-horizon-near"/>'+
    '</svg>'+
   '</div>'+
   '<div class="cc-seasonal-mist" aria-hidden="true"></div>'+
   decor.map((x,i)=>'<span class="cc-seasonal-float f'+(i+1)+'" aria-hidden="true">'+x+'</span>').join('')+
  '</div>'+
  '<div class="cc-seasonal-content">'+
   '<div>'+
    '<div class="cc-seasonal-kicker"><span class="cc-seasonal-kicker-dot"></span><span>'+theme.symbol+'</span><span>'+copy.name+'</span></div>'+
    '<h1 class="cc-seasonal-title">'+copy.name+'</h1>'+
    '<p class="cc-seasonal-subtitle">'+copy.tag+'</p>'+
    '<div class="cc-seasonal-quote">“'+copy.quote+'”</div>'+
   '</div>'+
   '<div class="cc-seasonal-side">'+
    '<div class="cc-seasonal-event-card">'+
     '<div class="cc-seasonal-event-head">'+
      '<span><span class="cc-seasonal-symbol">'+theme.symbol+'</span>'+copy.name+'</span>'+
      '<span class="cc-theme-chip">'+modeBadge+'</span>'+
     '</div>'+
     ccCountdownHtml(eventDays,resolved.target,copy)+
    '</div>'+
   '</div>'+
  '</div>';
}

function ccThemeOptions(){
 const groups=[['Season',['spring','summer','autumn','winter']],['Vietnam events',['tet','mid-autumn','hung-kings','liberation-day','labour-day','national-day','womens-day','children-day','family-day','vietnam-women','teachers-day','culture-day']]];
 return groups.map(g=>'<optgroup label="'+g[0]+'">'+g[1].map(id=>'<option value="'+id+'">'+CC_THEME_CATALOG[id].symbol+' '+CC_THEME_CATALOG[id].vi+' / '+CC_THEME_CATALOG[id].en+'</option>').join('')+'</optgroup>').join('');
}

function ccRenderSeasonalSettings(){
 if(typeof document==='undefined')return;
 const grid=document.querySelector('.cc-page[data-page="settings"] .cc-page-grid');
 if(!grid)return;
 let card=document.getElementById('ccSeasonalSettings');
 if(!card){
  card=document.createElement('section');
  card.id='ccSeasonalSettings';
  card.className='cc-seasonal-settings';
  grid.insertBefore(card,grid.firstChild);
 }
 const resolved=ccResolveTheme();
 const mode=ccReadSeasonSetting(CC_SEASON_MODE_KEY,'event-first'),manual=ccReadSeasonSetting(CC_SEASON_THEME_KEY,'mid-autumn'),motion=ccReadSeasonSetting(CC_SEASON_MOTION_KEY,'reduced'),decor=ccReadSeasonSetting(CC_SEASON_DECOR_KEY,'balanced');
 const vi=document.documentElement.lang==='vi';
 card.innerHTML='<div class="cc-seasonal-settings-head"><div><h3>'+(vi?'Giao diện theo mùa & sự kiện':'Seasonal & event appearance')+'</h3><p>'+(vi?'Ưu tiên sự kiện Việt Nam, sau đó tự trở về Xuân · Hạ · Thu · Đông.':'Vietnam events take priority, then fall back to Spring · Summer · Autumn · Winter.')+'</p></div><span class="cc-theme-chip">'+(CC_THEME_CATALOG[resolved.id]?CC_THEME_CATALOG[resolved.id].symbol:'🌸')+' '+resolved.id+'</span></div>'+
 '<div class="cc-seasonal-settings-grid">'+
  '<label>'+(vi?'Chế độ':'Mode')+'<select id="ccSeasonMode"><option value="event-first">'+(vi?'Ưu tiên sự kiện':'Event first')+'</option><option value="seasonal">'+(vi?'Chỉ theo 4 mùa':'Seasonal only')+'</option><option value="manual">'+(vi?'Thủ công':'Manual')+'</option></select></label>'+
  '<label>'+(vi?'Chủ đề thủ công':'Manual theme')+'<select id="ccSeasonManual">'+ccThemeOptions()+'</select></label>'+
  '<label>'+(vi?'Chuyển động':'Motion')+'<select id="ccSeasonMotion"><option value="reduced">'+(vi?'Giảm bớt':'Reduced')+'</option><option value="full">'+(vi?'Đầy đủ':'Full')+'</option><option value="off">'+(vi?'Tắt':'Off')+'</option></select></label>'+
  '<label>'+(vi?'Mật độ trang trí':'Decoration density')+'<select id="ccSeasonDecor"><option value="balanced">'+(vi?'Cân bằng':'Balanced')+'</option><option value="rich">'+(vi?'Phong phú':'Rich')+'</option><option value="minimal">'+(vi?'Tối giản':'Minimal')+'</option></select></label>'+
 '</div>'+
 '<div class="cc-theme-preview">'+['spring','summer','autumn','winter','tet','mid-autumn','hung-kings','liberation-day','labour-day','national-day'].map(id=>'<button type="button" data-cc-preview="'+id+'" class="'+(id===resolved.id?'active':'')+'">'+CC_THEME_CATALOG[id].symbol+' '+(vi?CC_THEME_CATALOG[id].vi:CC_THEME_CATALOG[id].en)+'</button>').join('')+'</div>';
 const m=document.getElementById('ccSeasonMode'),t=document.getElementById('ccSeasonManual'),mo=document.getElementById('ccSeasonMotion'),de=document.getElementById('ccSeasonDecor');
 if(m&&t&&mo&&de){
  m.value=mode;t.value=manual;mo.value=motion;de.value=decor;
  const refresh=()=>{ccRenderSeasonalHero();ccRenderSeasonalSettings();};
  m.onchange=()=>{ccWriteSeasonSetting(CC_SEASON_MODE_KEY,m.value);refresh();};
  t.onchange=()=>{ccWriteSeasonSetting(CC_SEASON_THEME_KEY,t.value);if(m.value!=='manual'){ccWriteSeasonSetting(CC_SEASON_MODE_KEY,'manual');}refresh();};
  mo.onchange=()=>{ccWriteSeasonSetting(CC_SEASON_MOTION_KEY,mo.value);refresh();};
  de.onchange=()=>{ccWriteSeasonSetting(CC_SEASON_DECOR_KEY,de.value);refresh();};
  card.querySelectorAll('[data-cc-preview]').forEach(btn=>btn.onclick=()=>{ccWriteSeasonSetting(CC_SEASON_THEME_KEY,btn.dataset.ccPreview);ccWriteSeasonSetting(CC_SEASON_MODE_KEY,'manual');refresh();});
 }
}

function initSeasonalThemeSystem(){
 if(typeof document==='undefined')return;
 ccRenderSeasonalHero();ccRenderSeasonalSettings();
 const obs=new MutationObserver(muts=>{if(muts.some(m=>m.type==='attributes'&&m.attributeName==='lang')){ccRenderSeasonalHero();ccRenderSeasonalSettings();}});
 obs.observe(document.documentElement,{attributes:true,attributeFilter:['lang']});
 setInterval(()=>ccRenderSeasonalHero(),60000);
 setInterval(ccTickCountdown,1000);
}
`;
