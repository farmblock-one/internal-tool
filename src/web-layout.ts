// Khung trang + toàn bộ CSS/JS phía trình duyệt của web UI — tách riêng khỏi server.ts cho gọn.
// Màu, font, "logo rings" theo NSC Brand Guideline: #36c3dc (light) / #0081bb (dark), Montserrat.

export const BRAND_NAME = 'Tool lọc leads tự động';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLES = `
:root {
  --nsc-light: #36c3dc;
  --nsc-dark: #0081bb;
  --nsc-navy: #04182b;
  --nsc-navy-2: #072a45;
  --ink: #0f1b26;
  --ink-2: #4a5866;
  --ink-3: #8593a1;
  --line: #e3eaf0;
  --bg: #f3f7fa;
  --card: #ffffff;
  --ok: #12a26f;
  --warn: #e09a07;
  --err: #d94141;
  --radius: 18px;
  --shadow-sm: 0 1px 2px rgba(4, 24, 43, 0.05), 0 2px 8px rgba(4, 24, 43, 0.04);
  --shadow-md: 0 10px 30px -12px rgba(4, 24, 43, 0.18);
  --ease: cubic-bezier(0.22, 1, 0.36, 1);
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0; min-height: 100vh; display: flex; flex-direction: column;
  font-family: 'Montserrat', -apple-system, 'Segoe UI', Roboto, sans-serif;
  color: var(--ink); background: var(--bg); -webkit-font-smoothing: antialiased;
}
a { color: var(--nsc-dark); font-weight: 600; text-decoration: none; transition: color .2s; }
a:hover { color: var(--nsc-light); }
button { font-family: inherit; }

/* ---------- Animations ---------- */
@keyframes rise { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: none; } }
@keyframes fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes ripple { 0% { transform: translate(-50%, -50%) scale(.35); opacity: 0; } 15% { opacity: .55; } 100% { transform: translate(-50%, -50%) scale(1.6); opacity: 0; } }
@keyframes drift { 0%, 100% { transform: translate(0, 0); } 50% { transform: translate(30px, -20px); } }
@keyframes shimmer { from { background-position: -200% 0; } to { background-position: 200% 0; } }
@keyframes pulse-dot { 0%, 100% { box-shadow: 0 0 0 0 currentColor; } 70% { box-shadow: 0 0 0 6px transparent; } }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes indeterminate { 0% { left: -40%; } 100% { left: 100%; } }
@keyframes flow { to { stroke-dashoffset: -24; } }
@keyframes sheen { from { transform: translateX(-120%) skewX(-20deg); } to { transform: translateX(220%) skewX(-20deg); } }
.reveal { animation: rise .7s var(--ease) backwards; }
.d1 { animation-delay: .06s; } .d2 { animation-delay: .12s; } .d3 { animation-delay: .18s; } .d4 { animation-delay: .24s; } .d5 { animation-delay: .3s; }
html.is-ready .reveal { animation: none; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; }
}

/* ---------- Header ---------- */
.hdr {
  position: sticky; top: 0; z-index: 50;
  background: linear-gradient(100deg, var(--nsc-dark) 0%, var(--nsc-light) 50%, var(--nsc-dark) 100%);
  background-size: 200% 100%;
  box-shadow: 0 6px 24px -10px rgba(0, 129, 187, .55);
}
.hdr-inner { max-width: 1080px; margin: 0 auto; padding: 14px 24px; display: flex; align-items: center; gap: 18px; }
.hdr-logo { height: 34px; width: auto; display: block; }
.hdr-sep { width: 1px; height: 26px; background: rgba(255,255,255,.4); }
.hdr-title { color: #fff; font-weight: 700; font-size: 1.02rem; letter-spacing: .01em; margin: 0; }
.hdr-home { margin-left: auto; color: rgba(255,255,255,.9); font-size: .82rem; font-weight: 600; display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 999px; background: rgba(255,255,255,.14); border: 1px solid rgba(255,255,255,.25); transition: background .25s; }
.hdr-home:hover { color: #fff; background: rgba(255,255,255,.26); }

.main { flex: 1; width: 100%; max-width: 1080px; margin: 0 auto; padding: 28px 24px 64px; }

/* ---------- Hero ---------- */
.hero {
  position: relative; overflow: hidden; border-radius: 28px; color: #fff; text-align: center;
  padding: 72px 28px 64px; margin-bottom: 28px; isolation: isolate;
  background:
    radial-gradient(ellipse 90% 70% at 50% -10%, rgba(54,195,220,.55) 0%, transparent 60%),
    linear-gradient(160deg, var(--nsc-navy-2) 0%, var(--nsc-navy) 55%, #031220 100%);
  box-shadow: 0 30px 70px -30px rgba(4, 24, 43, .7);
}
.hero-orb { position: absolute; border-radius: 50%; filter: blur(60px); z-index: -1; animation: drift 14s ease-in-out infinite; }
.hero-orb.a { width: 320px; height: 320px; background: rgba(0,129,187,.55); left: -80px; bottom: -120px; }
.hero-orb.b { width: 260px; height: 260px; background: rgba(54,195,220,.35); right: -60px; top: -60px; animation-delay: -7s; }
.hero-rings { position: absolute; left: 50%; top: 46%; width: 0; height: 0; z-index: -1; pointer-events: none; }
.hero-rings span {
  position: absolute; left: 0; top: 0; width: 900px; height: 900px; border-radius: 46% 54% 50% 50% / 52% 46% 54% 48%;
  border: 1px solid rgba(54,195,220,.55); animation: ripple 9s linear infinite;
}
.hero-rings span:nth-child(2) { animation-delay: -1.8s; }
.hero-rings span:nth-child(3) { animation-delay: -3.6s; }
.hero-rings span:nth-child(4) { animation-delay: -5.4s; }
.hero-rings span:nth-child(5) { animation-delay: -7.2s; }
.hero-mark { position: absolute; right: -40px; bottom: -50px; width: 360px; opacity: .06; z-index: -1; pointer-events: none; }
.hero-badge {
  display: inline-flex; align-items: center; gap: 8px; padding: 7px 16px; border-radius: 999px;
  font-size: .76rem; font-weight: 600; letter-spacing: .02em;
  background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.2); backdrop-filter: blur(6px);
}
.hero-badge i { width: 7px; height: 7px; border-radius: 50%; background: var(--nsc-light); color: var(--nsc-light); animation: pulse-dot 2s infinite; }
.hero h1 { font-size: clamp(2rem, 5vw, 3.2rem); line-height: 1.12; font-weight: 700; margin: 22px 0 14px; letter-spacing: -.01em; }
.hero h1 em {
  font-style: italic; font-weight: 600;
  background: linear-gradient(90deg, #fff 0%, var(--nsc-light) 40%, #fff 60%, var(--nsc-light) 100%);
  background-size: 200% auto; -webkit-background-clip: text; background-clip: text; color: transparent;
  animation: shimmer 6s linear infinite;
}
.hero-sub { max-width: 560px; margin: 0 auto 34px; color: rgba(255,255,255,.75); font-size: .95rem; line-height: 1.65; }
.hero-form {
  position: relative; max-width: 640px; margin: 0 auto; padding: 2px; border-radius: 20px;
  background: linear-gradient(120deg, rgba(54,195,220,.9), rgba(0,129,187,.6), rgba(54,195,220,.9));
  background-size: 200% 200%; box-shadow: 0 24px 60px -20px rgba(54,195,220,.55);
  transition: box-shadow .4s var(--ease), transform .4s var(--ease);
}
.hero-form:focus-within { box-shadow: 0 24px 70px -14px rgba(54,195,220,.85); transform: translateY(-2px); animation: shimmer 3s linear infinite; }
.hero-form-inner { display: flex; align-items: center; gap: 10px; background: #fff; border-radius: 18px; padding: 8px 8px 8px 20px; }
.hero-form svg.link { flex-shrink: 0; color: var(--ink-3); }
.hero-form input {
  flex: 1; min-width: 0; border: none; outline: none; background: transparent; font: inherit;
  font-size: .98rem; padding: 14px 0; color: var(--ink);
}
.hero-form input::placeholder { color: var(--ink-3); }
.btn-go {
  position: relative; overflow: hidden; display: inline-flex; align-items: center; gap: 8px; flex-shrink: 0;
  border: none; cursor: pointer; color: #fff; font-weight: 600; font-size: .92rem; padding: 14px 22px; border-radius: 14px;
  background: linear-gradient(135deg, var(--nsc-light), var(--nsc-dark));
  transition: transform .25s var(--ease), box-shadow .25s var(--ease);
}
.btn-go::after { content: ''; position: absolute; top: 0; left: 0; width: 40%; height: 100%; background: rgba(255,255,255,.35); transform: translateX(-120%) skewX(-20deg); }
.btn-go:hover { transform: translateY(-1px); box-shadow: 0 10px 24px -8px rgba(0,129,187,.7); }
.btn-go:hover::after { animation: sheen .8s var(--ease); }
.btn-go .spinner { display: none; width: 16px; height: 16px; border: 2px solid rgba(255,255,255,.4); border-top-color: #fff; border-radius: 50%; animation: spin .7s linear infinite; }
.btn-go.loading .spinner { display: inline-block; }
.btn-go.loading .arrow { display: none; }
.hero-hint { margin: 16px 0 0; font-size: .78rem; color: rgba(255,255,255,.55); }

/* Pipeline steps trong hero */
.flow { display: flex; justify-content: center; align-items: center; gap: 0; margin: 44px auto 0; max-width: 760px; flex-wrap: wrap; }
.flow-step { display: flex; flex-direction: column; align-items: center; gap: 8px; width: 130px; }
.flow-ico {
  width: 46px; height: 46px; border-radius: 14px; display: grid; place-items: center;
  background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.16); color: var(--nsc-light);
  transition: transform .3s var(--ease), background .3s;
}
.flow-step:hover .flow-ico { transform: translateY(-4px); background: rgba(54,195,220,.18); }
.flow-step b { font-size: .74rem; font-weight: 600; color: rgba(255,255,255,.85); }
.flow-line { width: 48px; height: 2px; margin-bottom: 26px; }
.flow-line line { stroke: rgba(54,195,220,.6); stroke-width: 2; stroke-dasharray: 4 8; animation: flow 1.2s linear infinite; }

/* ---------- Generic ---------- */
.card { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow-sm); }
.section-head { display: flex; align-items: center; gap: 12px; margin: 36px 0 14px; flex-wrap: wrap; }
.section-head h2 { margin: 0; font-size: 1.15rem; font-weight: 700; color: var(--ink); }
.section-head h2::before { content: ''; display: inline-block; width: 4px; height: 18px; border-radius: 4px; background: linear-gradient(var(--nsc-light), var(--nsc-dark)); margin-right: 10px; vertical-align: -3px; }
.section-head .count { font-size: .75rem; font-weight: 600; color: var(--ink-3); background: #eaf1f6; padding: 3px 10px; border-radius: 999px; }
.section-head .spacer { flex: 1; }

.btn {
  display: inline-flex; align-items: center; gap: 7px; cursor: pointer; font-weight: 600; font-size: .82rem;
  padding: 9px 16px; border-radius: 11px; border: 1px solid var(--line); background: #fff; color: var(--ink-2);
  transition: all .25s var(--ease);
}
.btn:hover { border-color: var(--nsc-light); color: var(--nsc-dark); transform: translateY(-1px); box-shadow: var(--shadow-sm); }
.btn-primary { background: linear-gradient(135deg, var(--nsc-light), var(--nsc-dark)); color: #fff; border-color: transparent; }
.btn-primary:hover { color: #fff; box-shadow: 0 10px 24px -10px rgba(0,129,187,.8); }
.btn-danger:hover { border-color: var(--err); color: var(--err); background: #fff5f5; }
.btn-danger.solid { background: var(--err); color: #fff; border-color: var(--err); }
.btn-danger.solid:hover { background: #c03535; color: #fff; }
.icon-btn { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 9px; border: 1px solid transparent; background: transparent; color: var(--ink-3); cursor: pointer; transition: all .2s; }
.icon-btn:hover { color: var(--err); background: #fff1f1; border-color: #f6d4d4; }

/* Stats */
.stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
.stat { padding: 18px 20px; position: relative; overflow: hidden; transition: transform .3s var(--ease), box-shadow .3s var(--ease); }
.stat:hover { transform: translateY(-3px); box-shadow: var(--shadow-md); }
.stat::after { content: ''; position: absolute; right: -24px; top: -24px; width: 80px; height: 80px; border-radius: 50%; background: var(--tint, rgba(54,195,220,.12)); }
.stat small { display: block; font-size: .72rem; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; color: var(--ink-3); }
.stat strong { display: block; font-size: 1.9rem; font-weight: 700; margin-top: 6px; color: var(--ink); font-variant-numeric: tabular-nums; }
.stat.run { --tint: rgba(224,154,7,.14); } .stat.ok { --tint: rgba(18,162,111,.13); } .stat.err { --tint: rgba(217,65,65,.12); }

/* Status chip */
.chip { display: inline-flex; align-items: center; gap: 7px; padding: 4px 11px; border-radius: 999px; font-size: .74rem; font-weight: 600; white-space: nowrap; }
.chip i { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.chip-queued { background: #eef1f5; color: #67768a; }
.chip-running { background: #fff5e0; color: #b57a00; }
.chip-running i { animation: pulse-dot 1.4s infinite; }
.chip-done { background: #e3f6ee; color: var(--ok); }
.chip-error { background: #fdeaea; color: var(--err); }
.chip-cancelled { background: #eceff3; color: #5b6878; text-decoration: line-through; text-decoration-thickness: 1px; }
.queue-pos { display: inline-flex; align-items: center; gap: 6px; font-size: .74rem; font-weight: 700; color: var(--nsc-dark); background: #e2f3fa; padding: 4px 10px; border-radius: 999px; }
@keyframes shake { 0%, 100% { transform: none; } 20%, 60% { transform: translateX(-6px); } 40%, 80% { transform: translateX(6px); } }
.dlg.shake { animation: shake .4s ease; }
.tag { display: inline-block; padding: 3px 9px; border-radius: 7px; font-size: .66rem; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
.tag-main { background: #e2f3fa; color: var(--nsc-dark); }
.tag-risky { background: #fff0de; color: #a85b00; }
.tag-reimport { background: #ecebfb; color: #4b3fae; }

/* Filter tabs */
.tabs { display: inline-flex; padding: 4px; gap: 2px; background: #e9f0f5; border-radius: 12px; }
.tabs button { border: none; background: transparent; padding: 7px 14px; border-radius: 9px; font-size: .78rem; font-weight: 600; color: var(--ink-2); cursor: pointer; transition: all .25s var(--ease); }
.tabs button.on { background: #fff; color: var(--nsc-dark); box-shadow: var(--shadow-sm); }

/* History list */
.jobs { overflow: hidden; }
.job-row {
  display: grid; grid-template-columns: 1fr auto auto auto; align-items: center; gap: 16px;
  padding: 16px 20px; border-bottom: 1px solid var(--line); transition: background .25s, opacity .35s var(--ease), transform .35s var(--ease);
}
.job-row:last-child { border-bottom: none; }
.job-row:hover { background: #f7fbfd; }
.job-row.leaving { opacity: 0; transform: translateX(24px); }
.job-row[hidden] { display: none; }
.job-main { min-width: 0; display: flex; align-items: center; gap: 14px; }
.job-ico { width: 40px; height: 40px; flex-shrink: 0; border-radius: 12px; display: grid; place-items: center; background: linear-gradient(135deg, rgba(54,195,220,.16), rgba(0,129,187,.12)); color: var(--nsc-dark); }
.job-ico.risky { background: #fff3e4; color: #c06d00; }
.job-ico.reimport { background: #efeefc; color: #4b3fae; }
.job-name { display: block; font-weight: 600; font-size: .92rem; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.job-meta { display: flex; align-items: center; gap: 8px; margin-top: 4px; font-size: .75rem; color: var(--ink-3); }
.job-time { font-size: .78rem; color: var(--ink-3); text-align: right; white-space: nowrap; }
.empty { padding: 56px 20px; text-align: center; color: var(--ink-3); }
.empty svg { color: var(--nsc-light); opacity: .7; margin-bottom: 10px; }
.empty b { display: block; color: var(--ink-2); font-size: .95rem; margin-bottom: 4px; }

/* Banners */
.banner { display: flex; gap: 14px; padding: 16px 20px; border-radius: 16px; margin-bottom: 14px; font-size: .88rem; line-height: 1.55; border: 1px solid; }
.banner p { margin: 4px 0 0; color: var(--ink-2); }
.banner ul { margin: 8px 0 0; padding-left: 18px; }
.banner li { margin: 4px 0; }
.banner-info { background: #eef8fc; border-color: #c9e9f4; }
.banner-warn { background: #fff8e8; border-color: #f4dfae; }
.banner-err { background: #fff2f2; border-color: #f3caca; color: #a12b2b; }
.banner .b-ico { flex-shrink: 0; width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; background: #fff; box-shadow: var(--shadow-sm); }
.mini-btn { margin-left: 6px; padding: 2px 9px; font-size: .72rem; font-weight: 600; background: #fff; color: #a85b00; border: 1px solid #e0b46a; border-radius: 6px; cursor: pointer; }

/* ---------- Job detail ---------- */
.back { display: inline-flex; align-items: center; gap: 6px; margin-bottom: 16px; font-size: .85rem; color: var(--ink-2); }
.back:hover { color: var(--nsc-dark); }
.back svg { transition: transform .25s var(--ease); }
.back:hover svg { transform: translateX(-3px); }
.detail { padding: 26px 28px; position: relative; overflow: hidden; }
.detail::before { content: ''; position: absolute; inset: 0 0 auto 0; height: 4px; background: linear-gradient(90deg, var(--nsc-light), var(--nsc-dark)); }
.detail-head { display: flex; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
.detail-head h1 { margin: 0; font-size: 1.35rem; font-weight: 700; word-break: break-word; }
.detail-head .grow { flex: 1; min-width: 240px; }
.detail-head .sub { margin-top: 8px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin-top: 22px; }
.meta { background: #f6f9fb; border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; min-width: 0; }
.meta small { display: block; font-size: .68rem; text-transform: uppercase; letter-spacing: .08em; font-weight: 600; color: var(--ink-3); }
.meta span { display: block; margin-top: 4px; font-size: .86rem; font-weight: 600; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.progress { position: relative; height: 4px; border-radius: 4px; background: #e6eef3; overflow: hidden; margin-top: 22px; }
.progress::after { content: ''; position: absolute; top: 0; height: 100%; width: 40%; border-radius: 4px; background: linear-gradient(90deg, var(--nsc-light), var(--nsc-dark)); animation: indeterminate 1.4s ease-in-out infinite; }
.progress.det::after { display: none; }
.progress .bar { position: absolute; inset: 0 auto 0 0; border-radius: 4px; background: linear-gradient(90deg, var(--nsc-light), var(--nsc-dark)); transition: width .6s var(--ease); }

.stepper { display: flex; margin-top: 26px; gap: 0; overflow-x: auto; padding-bottom: 4px; }
.step { flex: 1; min-width: 104px; position: relative; text-align: center; }
.step::before { content: ''; position: absolute; top: 15px; left: calc(-50% + 18px); right: calc(50% + 18px); height: 2px; background: var(--line); }
.step:first-child::before { display: none; }
.step.done::before, .step.active::before { background: linear-gradient(90deg, var(--nsc-light), var(--nsc-dark)); }
.step .dot { position: relative; z-index: 1; width: 32px; height: 32px; margin: 0 auto; border-radius: 50%; display: grid; place-items: center; font-size: .78rem; font-weight: 700; background: #fff; border: 2px solid var(--line); color: var(--ink-3); transition: all .4s var(--ease); }
.step.done .dot { background: linear-gradient(135deg, var(--nsc-light), var(--nsc-dark)); border-color: transparent; color: #fff; }
.step.active .dot { border-color: var(--nsc-light); color: var(--nsc-dark); box-shadow: 0 0 0 5px rgba(54,195,220,.18); }
.step.active .dot::after { content: ''; position: absolute; inset: -2px; border-radius: 50%; border: 2px solid transparent; border-top-color: var(--nsc-dark); animation: spin 1s linear infinite; }
.step.failed .dot { border-color: var(--err); color: var(--err); background: #fff2f2; }
.step b { display: block; margin-top: 8px; font-size: .72rem; font-weight: 600; color: var(--ink-2); }
.step.pending b { color: var(--ink-3); }

.actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 22px; }
.note { margin-top: 18px; font-size: .88rem; line-height: 1.6; color: var(--ink-2); }
.note.ok { color: var(--ok); }
.note ul { margin: 6px 0 0; padding-left: 18px; font-size: .84rem; }
.shots { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; margin-top: 12px; }
.shot { border: 1px solid var(--line); border-radius: 12px; overflow: hidden; background: #f6f9fb; }
.shot p { margin: 0; padding: 10px 14px; font-size: .78rem; font-weight: 600; color: var(--ink-2); }
.shot img { display: block; width: 100%; transition: transform .5s var(--ease); }
.shot:hover img { transform: scale(1.02); }

.terminal { margin-top: 0; border-radius: 16px; overflow: hidden; background: #0b1d2b; box-shadow: var(--shadow-md); }
.term-bar { display: flex; align-items: center; gap: 7px; padding: 12px 16px; background: #0f2638; border-bottom: 1px solid rgba(255,255,255,.06); }
.term-bar i { width: 11px; height: 11px; border-radius: 50%; background: #ff5f57; }
.term-bar i:nth-child(2) { background: #febc2e; } .term-bar i:nth-child(3) { background: #28c840; }
.term-bar span { margin-left: 10px; font-size: .75rem; color: #8fa9bd; font-weight: 600; }
.term-bar button { margin-left: auto; background: rgba(255,255,255,.06); color: #b7cad8; border: 1px solid rgba(255,255,255,.1); border-radius: 7px; font-size: .72rem; padding: 4px 10px; cursor: pointer; transition: background .2s; }
.term-bar button:hover { background: rgba(255,255,255,.14); }
.terminal pre { margin: 0; padding: 16px 18px; color: #d2e3ee; font: .78rem/1.65 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; word-break: break-word; max-height: 60vh; overflow: auto; }
.terminal pre::-webkit-scrollbar { width: 8px; } .terminal pre::-webkit-scrollbar-thumb { background: #234257; border-radius: 8px; }

/* ---------- Dialog & toast ---------- */
dialog.confirm { border: none; padding: 0; border-radius: 20px; width: min(420px, calc(100vw - 32px)); box-shadow: 0 40px 80px -20px rgba(4,24,43,.5); }
dialog.confirm[open] { animation: rise .35s var(--ease); }
dialog.confirm::backdrop { background: rgba(4, 24, 43, .45); backdrop-filter: blur(4px); animation: fade .3s; }
.dlg { padding: 28px; text-align: center; }
.dlg-ico { width: 56px; height: 56px; margin: 0 auto 14px; border-radius: 16px; display: grid; place-items: center; background: #fff1f1; color: var(--err); }
.dlg h3 { margin: 0 0 8px; font-size: 1.1rem; }
.dlg p { margin: 0 0 22px; font-size: .88rem; color: var(--ink-2); line-height: 1.6; }
.dlg .row { display: flex; gap: 10px; justify-content: center; }
.toast { position: fixed; left: 50%; bottom: 28px; transform: translate(-50%, 30px); opacity: 0; z-index: 100; background: var(--nsc-navy); color: #fff; padding: 12px 20px; border-radius: 12px; font-size: .85rem; font-weight: 600; box-shadow: var(--shadow-md); transition: all .4s var(--ease); pointer-events: none; }
.toast.show { transform: translate(-50%, 0); opacity: 1; }

/* ---------- Footer: Powered by NSC Software ---------- */
.ftr { position: relative; background: var(--nsc-navy); color: rgba(255,255,255,.6); overflow: hidden; }
.ftr::before { content: ''; position: absolute; inset: 0 0 auto 0; height: 1px; background: linear-gradient(90deg, transparent, var(--nsc-light), transparent); }
.ftr-inner { max-width: 1080px; margin: 0 auto; padding: 34px 24px; display: flex; flex-direction: column; align-items: center; gap: 14px; }
.powered { display: flex; align-items: center; gap: 18px; }
.powered .rule { width: 56px; height: 1px; background: linear-gradient(90deg, transparent, rgba(255,255,255,.45)); }
.powered .rule.r { background: linear-gradient(90deg, rgba(255,255,255,.45), transparent); }
.powered small { font-size: .66rem; font-weight: 500; letter-spacing: .42em; text-transform: uppercase; color: rgba(255,255,255,.7); }
.powered img { height: 36px; width: auto; display: block; opacity: .95; transition: opacity .3s, transform .4s var(--ease); }
.powered:hover img { opacity: 1; transform: translateY(-2px); }
.ftr-copy { font-size: .7rem; letter-spacing: .08em; color: rgba(255,255,255,.35); }

@media (max-width: 760px) {
  .main { padding: 20px 16px 48px; }
  .hdr-inner { padding: 12px 16px; gap: 12px; }
  .hdr-sep, .hdr-title { display: none; }
  .hero { padding: 52px 18px 44px; border-radius: 22px; }
  .hero-form-inner { padding-left: 14px; }
  .btn-go .lbl { display: none; }
  .flow-line { display: none; }
  .flow-step { width: 33%; margin-bottom: 14px; }
  .stats { grid-template-columns: repeat(2, 1fr); }
  .job-row { grid-template-columns: 1fr auto auto; gap: 10px; padding: 14px 14px; }
  .job-row .job-time { display: none; }
  .detail { padding: 22px 18px; }
  .meta-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .meta-grid .meta:first-child { grid-column: 1 / -1; }
  .powered { gap: 12px; } .powered .rule { width: 28px; }
}
`;

// JS phía trình duyệt: cập nhật "live" từng vùng [data-live] thay vì reload cả trang (không nháy,
// không mất chữ đang gõ), đếm số, lọc lịch sử, hộp thoại xác nhận xoá, copy log.
const SCRIPT = `
(() => {
  const root = document.documentElement;
  setTimeout(() => root.classList.add('is-ready'), 1200);

  const toast = (msg) => {
    let t = document.querySelector('.toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2400);
  };

  const countUp = (scope) => {
    scope.querySelectorAll('[data-count]').forEach((el) => {
      const to = Number(el.dataset.count) || 0;
      const from = Number(el.dataset.shown || 0);
      if (from === to && el.dataset.shown) return;
      el.dataset.shown = String(to);
      const t0 = performance.now();
      const step = (now) => {
        const p = Math.min(1, (now - t0) / 900);
        el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3)));
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  };

  let filter = 'all';
  try { filter = localStorage.getItem('nsc-filter') || 'all'; } catch {}
  const applyFilter = () => {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.f === filter));
    document.querySelectorAll('.job-row').forEach((r) => { r.hidden = filter !== 'all' && r.dataset.kind !== filter; });
  };

  const stickLog = () => {
    const pre = document.querySelector('.terminal pre');
    if (pre) pre.scrollTop = pre.scrollHeight;
  };

  const bind = () => { countUp(document); applyFilter(); };

  document.addEventListener('click', async (e) => {
    const tab = e.target.closest('.tabs button');
    if (tab) { filter = tab.dataset.f; try { localStorage.setItem('nsc-filter', filter); } catch {} applyFilter(); return; }

    const copy = e.target.closest('[data-copy-log]');
    if (copy) {
      const pre = document.querySelector('.terminal pre');
      try { await navigator.clipboard.writeText(pre ? pre.textContent : ''); toast('Đã copy log'); } catch { toast('Không copy được'); }
      return;
    }

    const opener = e.target.closest('[data-confirm]');
    if (opener) {
      e.preventDefault();
      const dlg = document.getElementById('confirm-dlg');
      dlg.querySelector('h3').textContent = opener.dataset.title || 'Xác nhận';
      dlg.querySelector('p').textContent = opener.dataset.confirm;
      dlg.querySelector('[data-dlg-ok]').textContent = opener.dataset.okLabel || 'Xoá';
      dlg._action = opener.dataset.action; dlg._row = opener.closest('.job-row');
      // Thao tác nguy hiểm (huỷ job) cần xác nhận LẦN 2 với nội dung + nút khác.
      dlg._confirm2 = opener.dataset.confirm2 ? { title: opener.dataset.title2, text: opener.dataset.confirm2, ok: opener.dataset.ok2Label } : null;
      dlg._stage2 = false;
      dlg.showModal();
      return;
    }

    const ok = e.target.closest('[data-dlg-ok]');
    if (ok) {
      const dlg = document.getElementById('confirm-dlg');
      if (dlg._confirm2 && !dlg._stage2) {
        dlg._stage2 = true;
        dlg.querySelector('h3').textContent = dlg._confirm2.title || 'Xác nhận lần 2';
        dlg.querySelector('p').textContent = dlg._confirm2.text;
        ok.textContent = dlg._confirm2.ok || 'Chắc chắn';
        const box = dlg.querySelector('.dlg');
        box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake');
        return;
      }
      dlg.close();
      const row = dlg._row;
      try {
        const res = await fetch(dlg._action, { method: 'POST', headers: { 'X-Requested-With': 'fetch' } });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { toast(data.message || 'Thao tác không thành công'); return; }
        if (data.redirect) { location.href = data.redirect; return; }
        if (row && !dlg._confirm2) { row.classList.add('leaving'); setTimeout(() => refresh(true), 350); } else { await refresh(true); }
        toast(data.message || 'Đã xoá');
      } catch { toast('Thao tác không thành công'); }
      return;
    }
    if (e.target.closest('[data-dlg-cancel]')) document.getElementById('confirm-dlg').close();
  });

  document.addEventListener('submit', (e) => {
    const btn = e.target.querySelector('.btn-go');
    if (btn) btn.classList.add('loading');
  });

  let timer;
  async function refresh(force) {
    clearTimeout(timer);
    try {
      const res = await fetch(location.href, { headers: { 'X-Requested-With': 'fetch' }, cache: 'no-store' });
      if (!res.ok) throw new Error();
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      const pre = document.querySelector('.terminal pre');
      const atBottom = !pre || pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
      document.querySelectorAll('[data-live]').forEach((el) => {
        const next = doc.querySelector('[data-live="' + el.dataset.live + '"]');
        if (next && next.innerHTML !== el.innerHTML) el.innerHTML = next.innerHTML;
      });
      if (atBottom) stickLog();
      bind();
      document.body.dataset.refresh = doc.body.dataset.refresh || '0';
    } catch {}
    schedule();
  }
  function schedule() {
    const s = Number(document.body.dataset.refresh || 0);
    if (s > 0) timer = setTimeout(refresh, s * 1000);
  }

  bind(); stickLog(); schedule();
})();
`;

const LOGO_WHITE = '/assets/nsc-logo-white.png';

export function pageLayout(title: string, body: string, refreshSeconds = 0): string {
  const year = new Date().getFullYear();
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<link rel="icon" type="image/png" href="/assets/nsc-favicon.png" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Montserrat:ital,wght@0,400;0,500;0,600;0,700;1,600&display=swap" rel="stylesheet" />
<style>${STYLES}</style>
</head>
<body data-refresh="${refreshSeconds}">
<header class="hdr">
  <div class="hdr-inner">
    <a href="/" aria-label="Trang chủ"><img class="hdr-logo" src="${LOGO_WHITE}" alt="NSC Software" /></a>
    <span class="hdr-sep"></span>
    <p class="hdr-title">${BRAND_NAME}</p>
    <a class="hdr-home" href="/">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
      Chạy list mới
    </a>
  </div>
</header>
<main class="main">
${body}
</main>
<footer class="ftr">
  <div class="ftr-inner">
    <div class="powered">
      <span class="rule"></span>
      <small>Powered by</small>
      <img src="${LOGO_WHITE}" alt="NSC Software" />
      <span class="rule r"></span>
    </div>
    <div class="ftr-copy">© ${year} NSC SOFTWARE · INTERNAL TOOL</div>
  </div>
</footer>
<dialog class="confirm" id="confirm-dlg">
  <div class="dlg">
    <div class="dlg-ico"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/></svg></div>
    <h3>Xác nhận</h3>
    <p></p>
    <div class="row">
      <button class="btn" data-dlg-cancel type="button">Huỷ</button>
      <button class="btn btn-danger solid" data-dlg-ok type="button">Xoá</button>
    </div>
  </div>
</dialog>
<script>${SCRIPT}</script>
</body>
</html>`;
}
