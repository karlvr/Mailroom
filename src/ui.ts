import {
  type Account,
  type AccountPermissions,
  type ContextSubject,
  type ContextSummaries,
  type ContextSummary,
  type ContextVersion,
  GLOBAL_CONTEXT,
  MAX_CONTEXT_CHARS,
  PERMISSION_LABELS,
  accountPermissions,
  grantedScopes,
} from "./db";
import { diffWords } from "./diff";
import { type AgentConnection, clientHost } from "./clients";
import { RELEASE_NOTES } from "./release-notes";
import { hasCalendar } from "./google";

export const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The font files in `public/fonts`, which the Worker serves as static assets. */
const FONTS = [
  { family: "IBM Plex Sans", weight: 400, file: "ibm-plex-sans-latin-400-normal.woff2" },
  { family: "IBM Plex Sans", weight: 500, file: "ibm-plex-sans-latin-500-normal.woff2" },
  { family: "IBM Plex Sans", weight: 600, file: "ibm-plex-sans-latin-600-normal.woff2" },
  { family: "IBM Plex Mono", weight: 400, file: "ibm-plex-mono-latin-400-normal.woff2" },
  { family: "IBM Plex Mono", weight: 500, file: "ibm-plex-mono-latin-500-normal.woff2" },
];

const FONT_FACES = FONTS.map(
  (f) => `@font-face{font-family:"${f.family}";font-weight:${f.weight};font-display:swap;src:url(/fonts/${f.file}) format("woff2")}`,
).join("\n");

/** Registration marks at the four corners of a box, as layers of one background. */
const TICKS = ["0 0/12px 1px", "0 0/1px 12px", "100% 0/12px 1px", "100% 0/1px 12px", "0 100%/12px 1px", "0 100%/1px 12px", "100% 100%/12px 1px", "100% 100%/1px 12px"]
  .map((layer) => `linear-gradient(var(--tick),var(--tick)) ${layer} no-repeat`)
  .join(",");

/** A hairline grid with cells of the given size, as two background layers that start at `position`. */
const grid = (cell: number, position: string) =>
  [`linear-gradient(var(--grid) 1px,transparent 1px)`, `linear-gradient(90deg,var(--grid) 1px,transparent 1px)`]
    .map((layer) => `${layer} ${position}/${cell}px ${cell}px`)
    .join(",");

const CSS = `
${FONT_FACES}
:root{color-scheme:light dark;--bg:#fff;--panel:#fff;--sunken:#f6f8f9;--ink:#0b1419;--muted:#55606a;--line:#e3e7ea;--strong:#c7ced4;--grid:rgba(11,20,25,.05);--envelope:rgba(11,20,25,.1);--tick:#9aa5ae;--field:#fff;--code:#f0f3f5;--accent:#0b7a55;--accent-soft:#e8f5ef;--accent-line:#b7dfcb;--accent-ink:#fff;--tile-line:#0b1419;--warn:#8a5300;--warn-bg:#fff7ea;--warn-line:#f0d6a8;--warn-strong:#c98a1b;--bad:#b42318;--bad-line:#f1b8b2;--bad-soft:#fdeceb;--btn:#0b1419;--btn-ink:#fff;--head:rgba(255,255,255,.88);--shadow:0 1px 2px rgba(11,20,25,.04),0 16px 40px -24px rgba(11,20,25,.2);--sans:"IBM Plex Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#070b0d;--panel:#0d1316;--sunken:#0a0f12;--ink:#e3e9ec;--muted:#8e9aa3;--line:#1b2429;--strong:#2a353b;--grid:rgba(140,170,160,.06);--envelope:rgba(140,170,160,.14);--tick:#3a474e;--field:#070b0d;--code:#152025;--accent:#3ddc97;--accent-soft:rgba(61,220,151,.1);--accent-line:rgba(61,220,151,.3);--accent-ink:#04140d;--tile-line:#2a353b;--warn:#f2b65c;--warn-bg:#1f170a;--warn-line:#4a3712;--warn-strong:#b9852f;--bad:#ff8a7a;--bad-line:#5a2620;--bad-soft:rgba(255,138,122,.12);--btn:#e3e9ec;--btn-ink:#070b0d;--head:rgba(7,11,13,.88);--shadow:0 24px 48px -24px rgba(0,0,0,.7)}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 var(--sans)}
.frame{position:relative;min-height:100vh;display:flex;flex-direction:column;overflow:hidden}
.backdrop{position:absolute;inset:0 0 auto;height:440px;overflow:hidden;pointer-events:none;background:${grid(32, "calc(50% + 16px) 0")};-webkit-mask-image:linear-gradient(#000,transparent);mask-image:linear-gradient(#000,transparent)}
.backdrop.envelope{height:760px;-webkit-mask-image:linear-gradient(#000 55%,transparent);mask-image:linear-gradient(#000 55%,transparent)}
.backdrop.letter{bottom:0;height:auto;-webkit-mask-image:none;mask-image:none}
.backdrop .art{position:absolute;left:50%;transform:translateX(-50%)}
.backdrop .art svg{display:block}
.env path{fill:none;stroke:var(--envelope);stroke-width:1}
.mark rect{stroke:var(--tile-line)}
.top{position:relative;border-bottom:1px solid var(--line);background:var(--head)}
.top>div,.foot>div{max-width:1160px;margin:0 auto;padding:0 clamp(16px,4vw,32px);display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:0 24px}
.top .left{display:flex;flex-wrap:wrap;align-items:center;gap:0 24px}
.brand{display:flex;align-items:center;gap:10px;min-height:56px;color:var(--ink);font-weight:600;font-size:17px;letter-spacing:-.015em;text-decoration:none}
.tag{padding:2px 8px;border:1px solid var(--strong);font:500 11px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.nav{display:flex;flex-wrap:wrap}
.nav a{display:inline-flex;align-items:center;min-height:56px;padding:0 10px;color:var(--muted);font-size:14px;font-weight:500;text-decoration:none}
.nav a:hover{color:var(--ink)}
.nav a[aria-current]{color:var(--ink);box-shadow:inset 0 -2px 0 var(--accent)}
.aside{display:flex;flex-wrap:wrap;align-items:center;gap:6px 18px;padding:10px 0;font:12.5px var(--mono);color:var(--muted)}
.aside a{color:var(--muted)}
.live{display:inline-flex;align-items:center;gap:8px}
.live::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
main{position:relative;flex:1;width:100%;max-width:824px;margin:0 auto;padding:40px clamp(16px,4vw,32px) 72px}
main.wide{max-width:1160px}
main.narrow{max-width:600px;padding-top:56px}
.foot{position:relative;border-top:1px solid var(--line);font:12px var(--mono);color:var(--muted)}
.foot>div{gap:8px 24px;padding-top:20px;padding-bottom:28px}
.foot a{color:var(--muted)}
h1{margin:0;font-size:36px;line-height:1.1;letter-spacing:-.03em;font-weight:600}
h2{margin:0;font-size:18px;line-height:1.3;letter-spacing:-.01em;font-weight:600}
p{margin:0 0 12px}
p:last-child{margin-bottom:0}
b{font-weight:600}
a{color:var(--accent);text-underline-offset:3px}
ul,ol{margin:6px 0 12px;padding-left:20px}
li{margin:4px 0}
code{font:13.5px var(--mono);background:var(--code);padding:1px 6px;overflow-wrap:anywhere}
.muted{color:var(--muted)}
.lede{margin:10px 0 0;max-width:640px;color:var(--muted)}
.lede b{color:var(--ink)}
.label{font:500 11px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.label.hot,.label .hot{color:var(--accent)}
.rule{display:flex;align-items:center;gap:12px;margin:0 0 18px;font:500 11.5px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.rule::after{content:"";order:1;flex:1;height:1px;background:var(--line)}
.rule .n{color:var(--accent)}
.rule .end{order:2}
.panel{position:relative;border:1px solid var(--line);background:var(--panel)}
.raised{box-shadow:var(--shadow)}
.ticks::before{content:"";position:absolute;inset:-7px;pointer-events:none;background:${TICKS}}
.ticks.accent{--tick:var(--accent)}
.pad{padding:22px 24px}
.motif{display:grid;place-items:center;height:144px;border-bottom:1px solid var(--line);background:${grid(16, "calc(50% + 8px) 50%")}}
.motif .env path{stroke:var(--tick)}
.btn,button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:0 18px;border:1px solid var(--btn);border-radius:6px;background:var(--btn);color:var(--btn-ink);font:500 15px/1.2 var(--sans);text-decoration:none;cursor:pointer}
.btn.secondary,button.secondary{border-color:var(--strong);background:var(--panel);color:var(--ink)}
.btn.big{min-height:46px;padding:0 20px}
button.danger{border-color:var(--bad-line);background:transparent;color:var(--bad)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:18px}
.copy{display:flex;align-items:stretch;margin:6px 0 12px;border:1px solid var(--strong);background:var(--field)}
.copy code{flex:1;min-width:0;display:flex;align-items:center;padding:10px 12px;background:none}
.copy button{flex:none;padding:0 16px;border:0;border-left:1px solid var(--strong);border-radius:0;background:none;color:var(--accent);font:500 12.5px var(--mono)}
.copy-label{margin-top:12px}
label{display:flex;flex-wrap:wrap;justify-content:space-between;gap:2px 8px;margin:18px 0 6px;font-weight:500;font-size:14px}
label:first-of-type{margin-top:0}
label .hint{font:400 12px var(--mono);color:var(--muted)}
input[type=text],input[type=password],textarea{display:block;width:100%;min-height:44px;padding:0 12px;border:1px solid var(--strong);border-radius:6px;background:var(--field);color:var(--ink);font:inherit;font-size:15px}
textarea{min-height:150px;padding:10px 12px;line-height:1.55;resize:vertical}
input:focus,textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.mono,input.mono,textarea.mono{font-family:var(--mono);font-size:14px}
input[type=checkbox]{flex:none;width:18px;height:18px;margin:0;accent-color:var(--accent)}
.help{margin:8px 0 0;font-size:14px;color:var(--muted)}
.notice{display:flex;align-items:flex-start;gap:10px;margin:0 0 24px;padding:10px 14px;border:1px solid var(--warn-line);background:var(--warn-bg);color:var(--warn);font-size:14.5px}
.notice svg{flex:none;margin-top:4px}
.notice a{color:inherit;font-weight:500}
.notice.info{border-color:var(--line);background:var(--sunken);color:var(--ink)}
.notice.info::before{content:"";flex:none;width:6px;height:6px;margin-top:9px;background:var(--accent)}
.notice.done{align-items:center;gap:12px;padding:12px 16px;border-color:var(--accent);background:var(--accent);color:var(--accent-ink);font-size:15px;font-weight:500}
.notice.done svg{width:16px;height:16px;margin-top:0}
.notice.error{border-color:var(--bad);background:var(--bad-soft);color:var(--ink)}
.notice.error svg{color:var(--bad)}
.band{display:flex;flex-wrap:wrap;align-items:center;gap:12px 20px;margin-top:-1px;padding:14px 20px;border-top:1px solid var(--warn-strong);border-bottom:1px solid var(--warn-line);background:var(--warn-bg);font-size:14.5px}
.band .label{color:var(--warn)}
.band p{flex:1 1 320px;margin:0}
.note{padding:12px 14px;border:1px solid var(--line);background:var(--sunken);font-size:14.5px;color:var(--muted)}
.note b{color:var(--ink)}
.pill{display:inline-flex;align-items:center;gap:7px;padding:2px 8px;border:1px solid var(--line);font:500 11.5px var(--mono);letter-spacing:.04em;text-transform:uppercase;color:var(--muted);white-space:nowrap}
.pill.ok{border-color:transparent;background:var(--accent-soft);color:var(--accent)}
.pill.ok::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.pill.send{border-color:var(--strong);color:var(--ink)}
.pill.warn{border-color:var(--warn-line);background:var(--warn-bg);color:var(--warn)}
.sect+.sect{margin-top:72px}
.title{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:16px 32px;margin-bottom:28px}
.title>div{flex:1 1 480px;min-width:0}
.mbx+.mbx{border-top:1px solid var(--line)}
.mbx>summary{position:relative;display:flex;flex-wrap:wrap;align-items:center;gap:10px 20px;padding:16px 64px 16px 20px;min-height:76px;list-style:none;cursor:pointer}
.mbx>summary::-webkit-details-marker{display:none}
.id{flex:0 0 64px;font:12px var(--mono);color:var(--accent)}
.id.warn{color:var(--warn)}
.who{flex:1 1 220px;min-width:0;display:flex;flex-direction:column;line-height:1.35}
.who b{font-size:16px}
.who span{font:12.5px var(--mono);color:var(--muted);overflow-wrap:anywhere}
.pills{display:flex;flex-wrap:wrap;gap:8px}
.chev{position:absolute;top:50%;right:12px;display:grid;place-items:center;width:44px;height:44px;margin-top:-22px;color:var(--muted)}
.mbx[open] .chev svg{transform:rotate(180deg)}
.mbx .body{border-top:1px dashed var(--strong)}
.mbx .body>.notice{margin:20px 20px 0}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:28px;padding:22px 20px 24px}
.caps{align-self:start;border:1px solid var(--line);background:var(--sunken)}
.fields{display:flex;flex-direction:column}
.fields textarea{flex:1 1 auto;min-height:260px}
.caps>.label{padding:10px 14px}
.caps .r{display:flex;justify-content:space-between;gap:12px;padding:9px 14px;border-top:1px solid var(--line);font-size:14.5px}
.caps .v{display:inline-flex;align-items:center;gap:6px;font:12px var(--mono);color:var(--accent)}
.caps .no,.caps .no .v{color:var(--muted)}
.caps .send{padding:12px 14px;border-top:1px solid var(--line);background:var(--panel)}
.toggle{align-items:center;gap:12px;margin:0;font-size:14.5px;cursor:pointer}
.caps .send .help+.toggle{margin-top:16px}
.actions{display:flex;flex-wrap:wrap;justify-content:space-between;gap:10px;padding:14px 20px;border-top:1px solid var(--line);background:var(--sunken)}
.actions .row{margin:0}
.register>.note{border:0;border-top:1px solid var(--line);font:12px var(--mono)}
.empty{display:flex;flex-direction:column;align-items:center;gap:14px;padding-bottom:28px;text-align:center}
.empty .motif{align-self:stretch}
.steps{margin:0;padding:0;list-style:none;counter-reset:step}
.steps>li{counter-increment:step;display:grid;grid-template-columns:28px minmax(0,1fr);gap:14px;margin:0 0 16px}
.steps>li::before{content:counter(step,decimal-leading-zero);display:grid;place-items:center;height:28px;border:1px solid var(--strong);font:500 12px var(--mono)}
.steps>li>div{padding-top:2px}
.connect{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr)}
.connect .steps{padding:22px 24px 6px}
.connect .side{border-left:1px solid var(--line);background:var(--sunken)}
.connect .side .label{margin-bottom:6px}
.connect .side p{font-size:14.5px;color:var(--muted)}
.connect .side p+.label{margin-top:20px}
@media (max-width:840px){.connect{grid-template-columns:minmax(0,1fr)}.connect .side{border-left:0;border-top:1px solid var(--line)}}
.split{display:flex;flex-wrap:wrap;align-items:flex-start;gap:32px;margin-top:36px}
.rail{flex:1 1 220px;display:flex;flex-direction:column;gap:16px}
.rail>.panel>.label{padding:10px 14px}
.rail a{display:flex;align-items:center;gap:12px;min-height:44px;padding:0 14px;border-top:1px solid var(--line);color:var(--ink);font-size:14.5px;text-decoration:none}
.rail a span{font:12px var(--mono);color:var(--accent)}
.rail a svg{margin-left:auto;color:var(--accent)}
.rail .worker{padding:12px 14px;background:var(--sunken)}
.rail .worker>.label{padding:0 0 2px}
.rail .worker .mono{font-size:12.5px;overflow-wrap:anywhere}
.stack{flex:999 1 560px;min-width:0;display:flex;flex-direction:column;gap:20px}
.step>.sh{display:flex;flex-wrap:wrap;align-items:center;gap:10px 16px;padding:14px 20px;border-bottom:1px solid var(--line)}
.step .num{flex:none;display:grid;place-items:center;width:36px;height:36px;border:1px solid var(--strong);font:500 13px var(--mono)}
.step h2{flex:1 1 180px}
.step .where{font:11.5px var(--mono);color:var(--muted)}
.step .sb{padding:18px 20px 20px}
.step .sb>*+*{margin-top:12px}
.step.done .num{border-color:transparent;background:var(--accent-soft);color:var(--accent)}
.step.focus{border-color:var(--accent)}
.step.new{border-color:var(--warn-line)}
.step.new .num{border-color:var(--warn-line);background:var(--warn-bg);color:var(--warn)}
.rail a span.new{margin-left:auto;color:var(--warn)}
.step.focus .num{border-color:var(--accent);background:var(--accent);color:var(--accent-ink)}
.sub{margin:0;padding:0;list-style:none;counter-reset:sub}
.sub>li{counter-increment:sub;display:grid;grid-template-columns:28px minmax(0,1fr);gap:14px;margin:0 0 12px}
.sub>li::before{content:var(--n) "." counter(sub);font:12.5px/1.95 var(--mono);color:var(--muted)}
.sub .notice{margin:10px 0 0}
.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:18px 24px}
.two .full{grid-column:1/-1}
.two label{margin-top:0}
.two .row{margin-top:0}
.hero{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,440px),1fr));gap:56px;align-items:center;padding-top:clamp(0px,4vw,48px)}
.chip{display:inline-flex;align-items:center;gap:10px;padding:6px 10px;border:1px solid var(--line);background:var(--panel);font:500 11.5px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.chip b{font-weight:500;color:var(--accent)}
.chip i{width:1px;height:12px;background:var(--line)}
.hero h1{margin-top:24px;font-size:clamp(38px,5.2vw,60px);line-height:1.04;letter-spacing:-.035em}
.hero .lede{margin-top:22px;max-width:520px;font-size:18px}
.hero .row{margin-top:32px;gap:12px}
.fine{margin:18px 0 0;font:12.5px var(--mono);color:var(--muted)}
.fig{margin:0}
.fig .cap{display:flex;flex-wrap:wrap;justify-content:space-between;gap:6px 12px;padding:10px 14px;border-bottom:1px solid var(--line)}
.fig .cap.end{border-top:1px solid var(--line);border-bottom:0}
.fig .body{position:relative;display:flex;flex-direction:column;align-items:center;padding:44px 20px 40px}
.fig .body::before{content:"";position:absolute;inset:0;background:${grid(16, "center")};-webkit-mask-image:radial-gradient(ellipse 70% 70% at 50% 50%,#000 40%,transparent);mask-image:radial-gradient(ellipse 70% 70% at 50% 50%,#000 40%,transparent)}
.fig .body>*{position:relative}
.node{display:flex;align-items:center;gap:12px;min-width:230px;padding:10px 14px;border:1px solid var(--strong);background:var(--panel);line-height:1.25}
.node .k{display:block;font:500 10.5px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.node b{display:block;font-size:15px}
.node.hub{min-width:260px;padding:12px 16px;border-color:var(--accent);box-shadow:0 0 0 4px var(--accent-soft)}
.node.hub .k{color:var(--accent)}
.ico{display:grid;place-items:center;width:30px;height:30px;border:1px solid var(--line);background:var(--sunken);color:var(--muted)}
.wire{width:1px;height:20px;background:var(--strong)}
.via{padding:3px 8px;border:1px solid var(--line);background:var(--panel);font:11px var(--mono);color:var(--muted)}
.fan{width:100%;max-width:480px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr))}
.fan::before{content:"";position:absolute;top:0;left:16.667%;right:16.667%;height:1px;background:var(--strong)}
.fan>div{display:flex;flex-direction:column;align-items:center;padding:0 5px}
.fan>div::before{content:"";width:1px;height:18px;background:var(--strong)}
.leaf{width:100%;padding:9px 10px;border:1px solid var(--line);background:var(--panel);line-height:1.3}
.leaf span{display:block;font:10.5px var(--mono);color:var(--accent)}
.leaf b{display:block;font-size:13.5px}
.leaf small{display:block;font:11px var(--mono);color:var(--muted)}
.facts{margin-top:clamp(56px,8vw,96px);display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,230px),1fr));gap:28px 32px;border-top:1px solid var(--line)}
.facts>div{position:relative;padding-top:20px}
.facts>div::before{content:"";position:absolute;top:-1px;left:0;width:28px;height:2px;background:var(--accent)}
.facts .label{display:flex;gap:10px}
.facts p{margin:8px 0 0;font-size:15px}
.link{display:flex;align-items:center;justify-content:center}
.link .ico{width:48px;height:48px;border-color:var(--strong);background:var(--panel)}
.link i{width:44px;border-top:1px dashed var(--strong)}
.link .via{color:var(--accent);letter-spacing:.08em}
.consent{margin-top:32px}
.consent h1,.message h1{font-size:28px;line-height:1.15;letter-spacing:-.025em}
.consent h1{margin-top:10px}
.consent .pad>.notice{margin:16px 0 0}
.kv{margin:0;border-top:1px solid var(--line)}
.kv>div{display:flex;flex-wrap:wrap;gap:2px 16px;padding:10px 24px}
.kv>div+div{border-top:1px solid var(--line)}
.kv dt{flex:0 0 140px;padding-top:3px}
.kv dd{flex:1 1 200px;min-width:0;margin:0;font:14px var(--mono);overflow-wrap:anywhere}
.kv dd .muted{display:block;font:14px var(--sans)}
.grp{padding:16px 24px 18px;border-top:1px solid var(--line)}
.grp.sunk{background:var(--sunken)}
.mbl{margin:4px 0 0;padding:0;list-style:none}
.mbl li{display:flex;flex-wrap:wrap;align-items:center;gap:4px 14px;margin:0;padding:10px 0}
.mbl li+li{border-top:1px solid var(--line)}
.mbl .id{flex-basis:56px}
.mbl .who{flex-direction:row;flex-wrap:wrap;align-items:baseline;gap:0 8px}
.can{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,190px),1fr));gap:8px 16px;margin-top:10px;font-size:14.5px}
.can span{display:inline-flex;align-items:center;gap:8px}
.can svg{flex:none;color:var(--accent)}
.can .no,.can .no svg{color:var(--muted)}
.decide .row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));margin-top:16px}
.doc{margin-top:16px}
.lede+.panel{margin-top:28px}
.doc h2{margin-bottom:10px}
.ctx-meta{margin:8px 0 0;font:12.5px var(--mono);color:var(--muted)}
.ctx-meta b{font-weight:500;color:var(--ink)}
.diff{margin:0;padding:16px 20px;border-top:1px solid var(--line);background:var(--field);font:14px/1.65 var(--sans);white-space:pre-wrap;overflow-wrap:anywhere}
.diff del{color:var(--bad);background:var(--bad-soft);text-decoration:line-through}
.diff ins{color:var(--accent);background:var(--accent-soft);text-decoration:none}
.diff .empty-text{color:var(--muted);font-style:italic}
.cap{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px 16px;padding:10px 20px;border-top:1px solid var(--line)}
.seg{display:inline-flex;flex-wrap:wrap;border:1px solid var(--strong)}
.seg>*{padding:6px 12px;font:500 12px var(--mono);color:var(--muted);text-decoration:none}
.seg>*+*{border-left:1px solid var(--strong)}
.seg a:hover{color:var(--ink)}
.seg [aria-current]{background:var(--btn);color:var(--btn-ink)}
.seg span{opacity:.45}
.history{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);gap:24px;align-items:start}
@media (max-width:840px){.history{grid-template-columns:minmax(0,1fr)}}
.vlist{margin:0;padding:0;list-style:none}
.vlist li+li{border-top:1px solid var(--line)}
.vlist a{display:flex;flex-direction:column;gap:2px;padding:12px 16px;color:var(--ink);text-decoration:none;font-size:14px}
.vlist a:hover{background:var(--sunken)}
.vlist a[aria-current]{background:var(--accent-soft);box-shadow:inset 3px 0 0 var(--accent)}
.vlist .n{display:flex;gap:8px;align-items:center;font:500 12px var(--mono);color:var(--accent)}
.vlist .m{font:12px var(--mono);color:var(--muted)}
.proposal+.proposal{margin-top:24px}
.proposal .actions{justify-content:flex-start}
[hidden]{display:none!important}
.seg button{min-height:0;padding:6px 12px;border:0;border-radius:0;background:none;color:var(--muted);font:500 12px var(--mono);cursor:pointer}
.seg button+button{border-left:1px solid var(--strong)}
.seg button:hover{color:var(--ink)}
.seg button[aria-selected=true]{background:var(--btn);color:var(--btn-ink)}
.edit{padding:16px 20px;border-top:1px solid var(--line)}
.edit textarea{min-height:240px;font:14px/1.65 var(--sans)}
.refs{margin:16px 0 0;padding:0;list-style:none;border-top:1px solid var(--line)}
.refs li{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:2px 16px;margin:0;padding:10px 0;border-bottom:1px solid var(--line)}
.refs a{font-weight:500}
.refs span{font:12.5px var(--mono);color:var(--muted)}
@media (max-width:560px){.refs li{flex-direction:column}}
.stack>.notice{margin:0}
`;

const TIME_JS = `document.querySelectorAll('time[datetime]').forEach(t=>{t.textContent=new Date(t.dateTime).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'})})`;

const COPY_JS = `document.addEventListener('click',e=>{const b=e.target.closest('[data-copy]');if(!b)return;navigator.clipboard.writeText(b.getAttribute('data-copy')).then(()=>{const t=b.textContent;b.textContent='Copied';setTimeout(()=>b.textContent=t,1200)})})`;

/** Returns an inline stroke icon on a square canvas of `view` units. The icon takes the text colour of its parent. */
const icon = (view: number, d: string, stroke = 1.6, size = view) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 ${view} ${view}" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linejoin="round"/></svg>`;

const ICON = {
  check: icon(12, "M2 6.3l2.6 2.6L10 3.2"),
  cross: icon(12, "M3 3l6 6M9 3l-6 6", 1.5),
  send: icon(12, "M1.5 6.2L10.5 1.5 7.8 10.5 6 6.8z", 1.2),
  warn: icon(12, "M6 1.5l5 9H1z M6 5v2.4 M6 8.6v.1", 1.2),
  chevron: icon(16, "M3.5 6l4.5 4.5 4.5-4.5"),
  arrow: icon(16, "M3 8h9M8.5 4.5L12 8l-3.5 3.5"),
  plus: icon(14, "M7 1.5v11M1.5 7h11"),
  client: icon(24, "M4.5 5.5h15v10h-9l-4 3v-3h-2z", 1.6, 18),
};

/**
 * Returns the Mailroom mark as an inline SVG: three strokes that make an M and the open sides of an
 * envelope, and a bar that closes the envelope. The SVG carries its own colours, so it also works
 * as a standalone file. `public/favicon.png` is a PNG copy of this mark: make it again when the
 * mark changes.
 */
const mark = (size: number) =>
  `<svg class="mark" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 40 40" aria-hidden="true"><rect x=".5" y=".5" width="39" height="39" rx="6.5" fill="#0b1419" stroke="#0b1419"/><path d="M11 26V12.5L20 20.5L29 12.5V26" fill="none" stroke="#fff" stroke-width="3"/><path d="M9.5 30H30.5" stroke="#3ddc97" stroke-width="3"/></svg>`;

/** An icon of the app that this Worker serves. */
export interface AppIcon {
  /** The path of the icon on this Worker. */
  path: string;
  mimeType: string;
  /** The sizes that the icon file contains, for example "192x192", or "any" for a vector icon. */
  sizes: string[];
}

/**
 * The icons of the app, in order of preference from lowest to highest. The Worker draws the SVG
 * with `favicon()`. The PNG is a static copy of the mark in `public/`, for services that do not
 * accept SVG.
 */
export const APP_ICONS = {
  png: { path: "/favicon.png", mimeType: "image/png", sizes: ["192x192"] },
  svg: { path: "/favicon.svg", mimeType: "image/svg+xml", sizes: ["any"] },
} satisfies Record<string, AppIcon>;

/** The size of an envelope-back drawing, in pixels. */
interface EnvelopeSize {
  width: number;
  height: number;
  /** The distance from the top edge to the point of the top flap. It must be more than half the height. */
  tip: number;
}

/**
 * Returns a hairline drawing of the back of an envelope: the outline, the top flap and the two
 * lower folds. Use sizes that are multiples of the cell of the grid behind it, so that the corners
 * and the point of the flap stay on grid lines.
 */
function envelope({ width, height, tip }: EnvelopeSize): string {
  const r = width - 0.5;
  const b = height - 0.5;
  // A lower fold stops where it meets the edge of the top flap, at half the height.
  const fold = +(((height / 2) * (width / 2)) / tip).toFixed(1);
  return `<svg class="env" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true"><path d="M.5 .5H${r}V${b}H.5Z M.5 .5L${width / 2} ${tip}L${r} .5 M.5 ${b}L${fold} ${height / 2} M${r} ${b}L${width - fold} ${height / 2}"/></svg>`;
}

/** A small envelope back on a fine grid, for the top of a panel. */
const motif = () => `<div class="motif" aria-hidden="true">${envelope({ width: 128, height: 80, tip: 44 })}</div>`;

/**
 * The drawing behind the content of a page.
 * - `grid`: a hairline grid that fades out down the page.
 * - `envelope`: the grid, with a large envelope back that opens from below the header.
 * - `letter`: the grid over the whole page, with a large envelope back behind a centred panel.
 */
export type Backdrop = "grid" | "envelope" | "letter";

const BACKDROPS: Record<Backdrop, string> = {
  grid: `<div class="backdrop" aria-hidden="true"></div>`,
  envelope: `<div class="backdrop envelope" aria-hidden="true"><div class="art" style="top:32px">${envelope({ width: 1216, height: 608, tip: 352 })}</div></div>`,
  letter: `<div class="backdrop letter" aria-hidden="true"><div class="art" style="top:224px">${envelope({ width: 1216, height: 640, tip: 352 })}</div></div>`,
};

/** A link in the header of a page. */
export interface NavLink {
  href: string;
  text: string;
  /** True when the link goes to the page that shows it. */
  current?: boolean;
}

/** Options for the frame around the content of a page: the header, the backdrop and the footer. */
export interface PageOptions {
  /** The name of the app, as the header and the window title show it. */
  app: string;
  /** A short label after the app name in the header, for example "Admin". */
  tag?: string;
  /** Links after the app name in the header. */
  nav?: NavLink[];
  /** HTML for the right side of the header. */
  aside?: string;
  /** The width of the content column. The default is `text`. */
  width?: "text" | "wide" | "narrow";
  /** The drawing behind the content. The default is `grid`. */
  backdrop?: Backdrop;
}

export function page(title: string, body: string, opts: PageOptions): Response {
  const app = esc(opts.app);
  const nav = opts.nav?.length
    ? `<nav class="nav" aria-label="Sections">${opts.nav
        .map((l) => `<a href="${esc(l.href)}"${l.current ? ` aria-current="page"` : ""}>${esc(l.text)}</a>`)
        .join("")}</nav>`
    : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
${Object.values(APP_ICONS)
  .map((i) => `<link rel="icon" href="${i.path}" type="${i.mimeType}" sizes="${i.sizes.join(" ")}">`)
  .join("\n")}
<link rel="preload" href="/fonts/${FONTS[0].file}" as="font" type="font/woff2" crossorigin>
<title>${esc(title)} · ${app}</title><style>${CSS}</style></head>
<body><div class="frame">${BACKDROPS[opts.backdrop ?? "grid"]}
<header class="top"><div><div class="left"><a class="brand" href="/">${mark(28)}<span>${app}</span></a>${
    opts.tag ? `<span class="tag">${esc(opts.tag)}</span>` : ""
  }${nav}</div>${opts.aside ? `<div class="aside">${opts.aside}</div>` : ""}</div></header>
<main class="${opts.width ?? "text"}">
${body}
</main>
<footer class="foot"><div><span>${app} is a self-hosted mailbox and calendar connector for AI agents. An agent can send email and calendar invitations only from an account where you allow it.</span><span><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/costs">Costs</a> · <a href="/release-notes">Release notes</a> · <a href="/setup">Admin setup</a></span></div></footer>
</div><script>${COPY_JS};${TIME_JS}</script></body></html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
    },
  });
}

/** Returns the mark as an SVG file, for the browser tab. */
export function favicon(): Response {
  return new Response(mark(40), {
    headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" },
  });
}

export const copyBox = (value: string) =>
  `<div class="copy"><code>${esc(value)}</code><button type="button" data-copy="${esc(value)}">Copy</button></div>`;

const section = (title: string, body: string) => `<section class="panel pad doc"><h2>${title}</h2>${body}</section>`;

/** The header links for a signed-in person: their address and a link to sign out. */
const signedIn = (who: string) => `<span>${esc(who)}</span><a href="/logout">Sign out</a>`;

/** Returns the label of the mailbox at a 1-based position in a list of mailboxes, for example "MBX·01". */
const mailboxId = (n: number) => `MBX·${String(n).padStart(2, "0")}`;

/**
 * Returns the domain to add as an authorized domain in Google Auth Platform for a host name.
 * Google accepts only a registrable domain, such as `example.com` or `you.workers.dev`. This knows
 * the `workers.dev` suffix and assumes a one-label public suffix for other hosts.
 */
const authorizedDomain = (hostname: string) =>
  hostname.split(".").slice(hostname.endsWith(".workers.dev") ? -3 : -2).join(".");

/** The kind of a message panel, which sets its style: the result of an action, a warning or an error. */
type NoticeKind = "done" | "warning" | "error";

const NOTICE_ICONS: Record<NoticeKind, string> = { done: ICON.check, warning: ICON.warn, error: ICON.cross };

/** Returns a message panel. `html` must be trusted HTML. */
const notice = (kind: NoticeKind, html: string) => `<div class="notice ${kind}">${NOTICE_ICONS[kind]}<span>${html}</span></div>`;

const warning = (html: string) => notice("warning", html);

/**
 * The messages that a page can show after a redirect, by code. The redirect names each code in a
 * `msg` parameter. A page shows only these fixed texts, never text from the request.
 */
const MESSAGES = {
  saved: { kind: "done", html: (a) => `${a} saved your changes.` },
  linked: {
    kind: "done",
    html: (a) => `${a} linked the mailbox.`,
  },
  "no-calendar": {
    kind: "warning",
    html: (a) => `${a} did not get the Calendar permissions, so agents cannot use the calendar of this mailbox. To add the calendar, click <b>Re-link</b> and keep the Calendar check boxes selected.`,
  },
  removed: { kind: "done", html: (a) => `${a} removed the mailbox and revoked its Google access.` },
  "form-expired": { kind: "error", html: () => "That form expired. Try again." },
  "context-too-long": {
    kind: "error",
    html: (a) => `The context can have at most ${MAX_CONTEXT_CHARS} characters. ${a} did not save your edits.`,
  },
  accepted: { kind: "done", html: (a) => `${a} accepted the proposal. It is now the current context.` },
  edited: { kind: "done", html: (a) => `${a} accepted the proposal with your edits. Your edited text is now the current context.` },
  rejected: { kind: "done", html: (a) => `${a} rejected and deleted the proposal.` },
  "proposal-not-found": { kind: "error", html: () => "That proposal does not exist, or it already has a decision." },
  restored: { kind: "done", html: (a) => `${a} restored the version. It is now the current context.` },
  unchanged: { kind: "warning", html: () => "That version has the same text as the current context. The context did not change." },
  "version-not-found": { kind: "error", html: () => "That version does not exist." },
} satisfies Record<string, { kind: NoticeKind; html: (escapedApp: string) => string }>;

/** The code of a message that a page can show after a redirect. */
export type MessageCode = keyof typeof MESSAGES;

/** Returns the message codes among `values`, in order. Use this on the `msg` parameters of a request, so that a page shows only known messages. */
export function messageCodes(values: readonly string[]): MessageCode[] {
  return values.filter((v): v is MessageCode => Object.hasOwn(MESSAGES, v));
}

/** Returns the message panels for these codes, in order. */
const messagePanels = (app: string, codes: readonly MessageCode[]) =>
  codes.map((c) => notice(MESSAGES[c].kind, MESSAGES[c].html(esc(app)))).join("\n");

export function messagePage(app: string, title: string, message: string, link?: { href: string; text: string }) {
  return page(
    title,
    `<div class="panel raised ticks message">${motif()}<div class="pad"><h1>${esc(title)}</h1><p class="lede">${esc(message)}</p>${
      link ? `<div class="row"><a class="btn" href="${esc(link.href)}">${esc(link.text)}</a></div>` : ""
    }</div></div>`,
    { app, width: "narrow" },
  );
}

export function adminLoginPage(app: string, error?: string) {
  return page(
    "Setup",
    `<div class="rule"><span class="n">Setup</span><span>Admin password</span></div>
<h1>${esc(app)} setup</h1>
<p class="lede">Enter the admin password that you chose when you deployed this Worker.</p>
<div class="panel raised ticks accent pad"><form method="post" action="/setup/login">
${error ? warning(esc(error)) : ""}
<label for="pw">Admin password</label><input id="pw" type="password" name="password" autocomplete="current-password" required autofocus>
<div class="row"><button>Continue</button></div></form></div>`,
    { app, tag: "Admin", width: "narrow" },
  );
}

/**
 * The version of the setup steps. Increase it when a release adds a setup step or changes what the
 * admin must do in a step, and set `changedIn` of that step to the new value.
 */
export const SETUP_VERSION = 2;

/** One step of the setup page. */
interface SetupStep {
  /** The name of the step in the list of steps. */
  short: string;
  title: string;
  /** A short label at the end of the heading, for example the site where the person does the step. */
  where: string;
  /** The HTML content of the step. */
  body: string;
  /** True when the step is complete. */
  done?: boolean;
  /** True when the person does the step on the setup page itself. */
  focus?: boolean;
  /** The setup version that added the step or last changed it. The default is 1. */
  changedIn?: number;
}

/** Returns a list of sub-steps. The step that contains the list supplies the number before each sub-step number. */
const subSteps = (items: string[]) => `<ol class="sub">${items.map((i) => `<li><div>${i}</div></li>`).join("")}</ol>`;

export function setupPage(
  app: string,
  origin: string,
  s: {
    configured: boolean;
    /** The setup version that the admin last completed. */
    completedVersion: number;
    clientId: string;
    allowlist: string;
    csrf: string;
    saved?: boolean;
    /** True when the admin confirmed the new steps a moment ago. */
    confirmed?: boolean;
    error?: string;
  },
) {
  const a = esc(app);
  const ext = (href: string, text: string) => `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
  const copyField = (label: string, value: string) => `<div class="label copy-label">${label}</div>${copyBox(value)}`;
  const steps: SetupStep[] = [
    {
      short: "Cloud project",
      title: "Create a Google Cloud project",
      where: "console.cloud.google.com",
      done: s.configured,
      body: `<p>${ext("https://console.cloud.google.com/projectcreate", "Create a project")}. You can use any name, for example <code>${a}</code>. Before you do the next steps, select the project in the project picker at the top of the page.</p>`,
    },
    {
      short: "Google APIs",
      title: "Enable the Gmail API and the Google Calendar API",
      where: "console.cloud.google.com",
      done: s.configured,
      changedIn: 2,
      body: subSteps([
        `${ext("https://console.cloud.google.com/apis/library/gmail.googleapis.com", "Open the Gmail API")} and click <b>Enable</b>.`,
        `${ext("https://console.cloud.google.com/apis/library/calendar-json.googleapis.com", "Open the Google Calendar API")} and click <b>Enable</b>.`,
      ]),
    },
    {
      short: "Sign-in screen",
      title: "Configure the sign-in screen",
      where: "Google Auth Platform",
      done: s.configured,
      body: `${subSteps([
        `${ext("https://console.cloud.google.com/auth/overview", "Open Google Auth Platform")}, then click <b>Get started</b>. For the app name, enter <code>${a}</code>. For the support email, enter your address.`,
        `For the audience, choose <b>External</b>. With this setting, you can link mailboxes from any Google account or Workspace. For the contact email, enter your address. Accept the policy, then click <b>Create</b>.`,
        `Open ${ext("https://console.cloud.google.com/auth/branding", "Branding")}. Google does not let you publish the app until you complete these fields. Under <b>App domain</b>, enter these links:
${copyField("Application home page", `${origin}/`)}
${copyField("Application privacy policy link", `${origin}/privacy`)}
${copyField("Application terms of service link", `${origin}/terms`)}
Under <b>Authorized domains</b>, add this domain:${copyBox(authorizedDomain(new URL(origin).hostname))}
Do not upload a logo. With a logo, Google must verify the app before you can publish it. Click <b>Save</b>.`,
        `Open ${ext("https://console.cloud.google.com/auth/audience", "Audience")}, then click <b>Publish app</b> and <b>Confirm</b>.
${warning("Do not skip this step. If you leave the app in “Testing”, Google expires the access every 7 days.")}`,
      ])}
<p class="note">You do not need app verification from Google, and you do not need to add scopes. When you link a mailbox, Google shows the warning “Google hasn't verified this app”. Click <b>Advanced</b>, then click <b>Go to ${a}</b>. This warning is normal for a private app.</p>`,
    },
    {
      short: "OAuth client",
      title: "Create the OAuth client",
      where: "Google Auth Platform",
      done: s.configured,
      body: subSteps([
        `${ext("https://console.cloud.google.com/auth/clients/create", "Create a client")}. For the application type, choose <b>Web application</b>. For the name, enter <code>${a}</code>.`,
        `Under <b>Authorized redirect URIs</b>, add this URI exactly:${copyBox(`${origin}/google/callback`)}`,
        `Click <b>Create</b>. Then copy the Client ID and the Client secret into step 5. <span class="muted">Google shows the secret only once. If you lose it, add a new secret on the page of the client.</span>`,
      ]),
    },
    {
      short: "Credentials",
      title: "Paste the credentials",
      where: "Stored encrypted",
      focus: true,
      body: `<form method="post" action="/setup" class="two">
<input type="hidden" name="csrf" value="${esc(s.csrf)}">
<div><label for="cid">Client ID</label><input id="cid" class="mono" type="text" name="client_id" value="${esc(s.clientId)}" placeholder="…apps.googleusercontent.com" required></div>
<div><label for="cs">Client secret</label><input id="cs" class="mono" type="password" name="client_secret" placeholder="${s.configured ? "Leave this field empty to keep the saved secret" : "GOCSPX-…"}" ${s.configured ? "" : "required"} autocomplete="off"></div>
<div class="full"><label for="al">Who can use this</label>
<textarea id="al" class="mono" name="allowlist" placeholder="you@example.com&#10;@yourcompany.com" required>${esc(s.allowlist)}</textarea>
<p class="help">Enter one entry on each line. A full address gives access to that person. An entry such as <code>@domain.com</code> gives access to every person at that domain. Each person links their own mailboxes and sees only those mailboxes.</p></div>
<div class="full row"><button>Save</button></div></form>`,
    },
    {
      short: "Workspace trust",
      title: "Trust the app in each Google Workspace",
      where: "admin.google.com",
      body: `<p>A Workspace admin can block unverified apps. If you cannot link a Workspace mailbox because of the error “access blocked”, do these steps in the Admin Console of that organisation:</p>
${subSteps([
  `${ext("https://admin.google.com/ac/owl/list?tab=configuredApps", "Open App access control")}, then click <b>Configure new app</b>.`,
  `Search for your Client ID${s.clientId ? `:${copyBox(s.clientId)}` : "."}`,
])}
<p>Select the app. Set the scope to your organisation. Set the access to <b>Trusted</b>. A personal @gmail.com account does not need this step.</p>`,
    },
  ];
  const number = (i: number) => String(i + 1).padStart(2, "0");
  // On a configured deployment, a step that changed after the version that the admin completed is new.
  const isNew = (st: SetupStep) => s.configured && (st.changedIn ?? 1) > s.completedVersion;
  const newSteps = steps.map((st, i) => ({ st, i })).filter(({ st }) => isNew(st));
  const rail = steps
    .map(
      (st, i) =>
        `<a href="#step-${i + 1}"><span>${number(i)}</span>${esc(st.short)}${
          isNew(st) ? `<span class="new">New</span>` : st.done ? ICON.check : ""
        }</a>`,
    )
    .join("");
  const cards = steps
    .map((st, i) => {
      const done = st.done && !isNew(st);
      return `<section id="step-${i + 1}" class="panel step${done ? " done" : ""}${isNew(st) ? " new" : ""}${st.focus ? " focus raised ticks accent" : ""}" style="--n:'${i + 1}'">
<div class="sh"><span class="num">${number(i)}</span><h2>${esc(st.title)}</h2>${isNew(st) ? `<span class="pill warn">New</span>` : ""}<span class="where">${esc(st.where)}</span></div>
<div class="sb">${st.body}</div></section>`;
    })
    .join("\n");
  const update = newSteps.length
    ? `<div class="notice">${ICON.warn}<div>This version of ${a} added or changed ${newSteps.length === 1 ? "a setup step" : `${newSteps.length} setup steps`}: ${newSteps
        .map(({ st, i }) => `<a href="#step-${i + 1}">${number(i)} ${esc(st.short)}</a>`)
        .join(", ")}. Do the ${newSteps.length === 1 ? "step" : "steps"} marked New, then click <b>I did these steps</b>. Until then, the Mailboxes page asks the admin to open this page.
<form method="post" action="/setup/confirm" class="row"><input type="hidden" name="csrf" value="${esc(s.csrf)}"><button>I did these steps</button></form></div></div>`
    : "";
  return page(
    "Setup",
    `<div class="rule"><span class="n">Setup</span><span>Google OAuth</span><span class="end">${steps.length} steps</span></div>
<h1>Connect to Google</h1>
<p class="lede">You do this setup only once. It takes about 10 minutes. Each link opens the Google Cloud screen for that step in a new tab. Keep this page open. When a new version of ${a} adds or changes a step, this page marks the step New.</p>
<div class="split">
<nav class="rail" aria-label="Setup steps"><div class="panel"><div class="label">Steps</div>${rail}</div>
<div class="panel worker"><div class="label">This Worker</div><div class="mono">${esc(new URL(origin).host)}</div></div></nav>
<div class="stack">
${s.saved ? notice("done", `${a} saved the settings. <a href="/">Sign in and link your mailboxes →</a>`) : ""}
${s.confirmed ? notice("done", `${a} recorded that the setup is up to date.`) : ""}
${update}
${s.error ? warning(esc(s.error)) : ""}
<div class="notice info"><span>The Mailroom software is free of charge. You pay the costs of your Cloudflare account and your Google Cloud project. To decide which plans you need, read <a href="/costs">Costs</a>.</span></div>
${cards}
</div></div>`,
    { app, tag: "Admin", width: "wide", aside: `<a href="/">Back to ${a}</a>` },
  );
}

export function landingPage(app: string, origin: string, configured: boolean) {
  const a = esc(app);
  const leaf = (n: number, kind: string, name: string) =>
    `<div><div class="leaf"><span>${mailboxId(n)}</span><b>${kind}</b><small>${name}</small></div></div>`;
  const fact = (n: number, title: string, body: string) =>
    `<div><div class="label"><span class="hot">${String(n).padStart(2, "0")}</span><span>${title}</span></div><p>${body}</p></div>`;
  return page(
    "Welcome",
    `<div class="hero">
<div>
<span class="chip"><b>MCP</b><i></i>Gmail and Google Workspace</span>
<h1>All your mailboxes.<br>Each with its own context.</h1>
<p class="lede">${a} is a self-hosted connector for AI agents, such as Claude, ChatGPT and Codex. An agent can search, read, label, draft and trash email in each Gmail and Workspace mailbox that you link. An agent can also read its calendar, find free time and schedule events.</p>
${
  configured
    ? `<div class="row"><a class="btn big" href="/login">Sign in with Google${ICON.arrow}</a><a class="btn big secondary" href="/setup">Admin setup</a></div>
<p class="fine">Each person signs in with Google and sees only their own mailboxes. You must trust the operator of this ${a}, because the operator can get access to the mailboxes that you link. Read the <a href="/privacy">privacy policy</a>.</p>`
    : `<div class="row"><a class="btn big" href="/setup">Start setup${ICON.arrow}</a></div>
<p class="fine">${a} is not connected to Google yet.</p>`
}
</div>
<figure class="panel raised ticks accent fig">
<figcaption class="cap label"><span><span class="hot">Fig. 01</span> How it connects</span><span>Example</span></figcaption>
<div class="body">
<div class="node"><span class="ico">${ICON.client}</span><span><span class="k">Agent</span><b>Claude, ChatGPT, Codex</b></span></div>
<span class="wire"></span><span class="via">MCP · OAuth · /mcp</span><span class="wire"></span>
<div class="node hub">${mark(30)}<span><span class="k">Your Worker</span><b>${a}</b></span></div>
<span class="wire"></span>
<div class="fan">${leaf(1, "Gmail", "personal")}${leaf(2, "Workspace", "acme")}${leaf(3, "Workspace", "studio")}</div>
</div>
<div class="cap end label"><span>Tokens · AES-GCM 256</span><span>Sending · off by default</span></div>
</figure>
</div>
<div class="facts">
${fact(1, "Hosting", `${a} runs on the Cloudflare account of the person or organisation that deployed it.`)}
${fact(2, "Credentials", `${a} encrypts the Google tokens that it stores. The operator of this ${a} can decrypt the tokens, so you must trust the operator. Read the <a href="/privacy">privacy policy</a>.`)}
${fact(3, "Sending", `An agent can send email, send calendar invitations and RSVP to invitations only from an account where you allow it. An agent cannot delete email permanently.`)}
${fact(4, "Content", `${a} instructs agents to treat email and calendar content as data, never as instructions.`)}
</div>`,
    { app, width: "wide", backdrop: "envelope", aside: `<span class="live">${esc(new URL(origin).host)}</span>` },
  );
}

export function privacyPage(app: string, origin: string) {
  const a = esc(app);
  return page(
    "Privacy policy",
    `<h1>Privacy policy</h1>
<p class="lede">This policy applies to ${a} at <b>${esc(new URL(origin).host)}</b>. ${a} connects Gmail and Google Workspace mailboxes and calendars to the AI agents that you connect, such as Claude, ChatGPT and Codex. The person or organisation that deployed ${a} operates it. Cloudflare hosts it.</p>
${section(
  `Data that ${a} stores`,
  `<ul><li>Your Google account ID, your email address, your global context, and the times of your first and last sign-in.</li>
<li>For each mailbox that you link: its address, its short name, its context notes, the settings <b>${esc(PERMISSION_LABELS.sendEmail)}</b>, <b>${esc(PERMISSION_LABELS.sendInvitations)}</b> and <b>${esc(PERMISSION_LABELS.rsvp)}</b>, the Google permissions that you granted, and a Google refresh token. ${a} encrypts the token before it stores it.</li>
<li>For your global context and for each mailbox: each version of the context notes that you saved or accepted, when the version became current, and who made it. For a change that an agent proposed, ${a} also stores the name of the app, and the name and the reason that the agent gave. ${a} deletes a proposal when you reject it.</li>
<li>Your web session, a record of each agent connection that you approve, and the version of the tool list that each connection loaded last.</li></ul>
<p>${a} does not store the content of your email or your calendar events.</p>`,
)}
${section(
  `How ${a} uses your Google data`,
  `<p>${a} uses Google sign-in to get your verified email address. ${a} uses the Gmail API and the Google Calendar API only when an agent calls one of the ${a} tools. ${a} then sends the result to that agent through the connection that you approved.</p>
<p>The tools can search, read, label and trash email, and save drafts of new messages, replies and forwards. ${a} sends email only from a mailbox where you select <b>${esc(PERMISSION_LABELS.sendEmail)}</b>.</p>
<p>The tools can read calendars, find free time, and create, change and delete events. ${a} sends calendar invitations only from a mailbox where you select <b>${esc(PERMISSION_LABELS.sendInvitations)}</b>. ${a} RSVPs to invitations only for a mailbox where you select <b>${esc(PERMISSION_LABELS.rsvp)}</b>.</p>
<p>${a} does not sell your data. ${a} does not use your data for advertising or to train AI models.</p>
<p>The use and transfer of information that ${a} receives from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noopener">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>`,
)}
${section(
  "Who receives your data",
  `<ul><li><b>Google</b> supplies the sign-in, the Gmail API and the Google Calendar API. Your email stays in Gmail, and your events stay in Google Calendar.</li>
<li><b>The provider of each agent that you connect</b> receives the email and calendar data that ${a} sends to that agent. For Claude and Claude Code, the provider is <b>Anthropic</b>, and the <a href="https://www.anthropic.com/legal/privacy" target="_blank" rel="noopener">Anthropic privacy policy</a> and your Claude settings apply to that data. For ChatGPT and Codex, the provider is <b>OpenAI</b>, and the <a href="https://openai.com/policies/privacy-policy/" target="_blank" rel="noopener">OpenAI privacy policy</a> and your ChatGPT settings apply to that data. For another app, the privacy policy of its provider applies.</li>
<li><b>Cloudflare</b> runs ${a} and stores its data. Cloudflare can keep request logs.</li></ul>
<p>${a} does not send your data to other parties.</p>`,
)}
${section(
  "Who can access your mailboxes",
  `<p>The person or organisation that operates ${a} can decrypt the Google tokens that ${a} stores. The operator can also change the code of ${a}. Thus the operator can get all the access to your mailboxes and calendars that you gave to ${a}. The settings of a mailbox do not limit the operator.</p>
<p>${a} encrypts the tokens to protect them if a copy of the database leaks. The encryption does not protect the tokens from the operator. Link a mailbox only if you trust the operator.</p>`,
)}
${section(
  "Remove your data",
  `<ul><li>To unlink a mailbox, click <b>Remove</b> on the ${a} home page. ${a} deletes the stored token and the context history, and revokes the Google access of that mailbox.</li>
<li>To stop the access of an agent, remove the ${a} connector in the app of that agent.</li>
<li>You can also revoke the access of ${a} on the <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener">third-party connections</a> page of your Google account.</li>
<li>To delete all your data, contact the operator of ${a}.</li></ul>`,
)}
${section(
  "Contact",
  `<p>For questions about this policy, contact the person or organisation that gave you access to ${a}.</p>`,
)}`,
    { app },
  );
}

export function termsPage(app: string, origin: string) {
  const a = esc(app);
  return page(
    "Terms of service",
    `<h1>Terms of service</h1>
<p class="lede">These terms apply to ${a} at <b>${esc(new URL(origin).host)}</b>. The person or organisation that deployed ${a} operates it. When you use ${a}, you agree to these terms.</p>
${section(
  "Access",
  `<p>Only the people that the operator allows can sign in. Link only the mailboxes that you have permission to use.</p>`,
)}
${section(
  "Your instructions",
  `<p>An agent uses ${a} when you instruct it. You are responsible for your instructions and for the actions that an agent does because of them. Select <b>${esc(PERMISSION_LABELS.sendEmail)}</b> only for a mailbox where you accept that an agent can send email. Select <b>${esc(PERMISSION_LABELS.sendInvitations)}</b> and <b>${esc(PERMISSION_LABELS.rsvp)}</b> only for a mailbox where you accept that an agent can send calendar invitations and RSVPs.</p>
<p>${a} instructs agents to treat email and calendar content as data, never as instructions. This instruction reduces the risk that an email or an event tricks an agent, but it cannot remove the risk.</p>`,
)}
${section(
  "No warranty",
  `<p>The operator supplies ${a} “as is”, without warranty of any kind. To the extent that the law permits, the operator is not liable for loss or damage from the use of ${a}. This includes email that an agent sends, labels or trashes, and calendar events that an agent creates, changes, deletes or replies to.</p>`,
)}
${section(
  "Changes",
  `<p>The operator can change these terms or stop your access at any time. You can stop the use of ${a} at any time. For information about how ${a} uses your data, read the <a href="/privacy">privacy policy</a>.</p>`,
)}`,
    { app },
  );
}

export function costsPage(app: string) {
  const a = esc(app);
  const ref = (href: string, text: string, about: string) =>
    `<li><a href="${href}" target="_blank" rel="noopener">${text}</a><span>${about}</span></li>`;
  return page(
    "Costs",
    `<h1>Costs</h1>
<p class="lede">The Mailroom software is free of charge. ${a} runs on a Cloudflare account and uses a Google Cloud project, and these services can have costs. The person or organisation that deployed ${a} pays these costs. This page lists the services that ${a} uses, with links to their prices. Use these links to decide which plans you need.</p>
${section(
  "Cloudflare",
  `<p>${a} uses Workers, Workers KV, D1, static assets and Workers Logs. The Workers Free plan includes a daily allowance for each service that has a charge. On the Free plan, Cloudflare does not charge for use above an allowance. Instead, requests can fail until the allowance resets.</p>
<p>The Free plan also limits the CPU time of each request. A request that reads a large email can go over this limit and fail. The Workers Paid plan has a higher limit. It has a minimum monthly charge, and Cloudflare charges for use above the amounts that it includes.</p>
<ul class="refs">
${ref("https://developers.cloudflare.com/workers/platform/pricing/", "Workers pricing", "Plans, requests, CPU time, static assets")}
${ref("https://developers.cloudflare.com/workers/platform/limits/", "Workers limits", "CPU time for each request")}
${ref("https://developers.cloudflare.com/kv/platform/pricing/", "Workers KV pricing", "Reads, writes, storage")}
${ref("https://developers.cloudflare.com/d1/platform/pricing/", "D1 pricing", "Rows read, rows written, storage")}
${ref("https://developers.cloudflare.com/observability/pricing/", "Observability pricing", "Workers Logs")}
</ul>`,
)}
${section(
  "Google",
  `<p>${a} uses a Google Cloud project for Google sign-in, the Gmail API and the Google Calendar API. Google does not charge for standard use of these APIs. Google plans to charge for use above a daily threshold for each API, and states that it will give at least 90 days’ notice.</p>
<p>Google limits the number of users of an unverified app. For more users, Google must verify the app. ${a} uses a restricted Gmail permission, so the verification includes a security assessment each year. An independent assessor does the assessment and can charge a fee.</p>
<ul class="refs">
${ref("https://developers.google.com/workspace/gmail/api/reference/quota", "Gmail API usage limits", "Quotas, daily billing threshold")}
${ref("https://developers.google.com/workspace/calendar/api/guides/quota", "Calendar API usage limits", "Quotas, daily billing threshold")}
${ref("https://support.google.com/cloud/answer/7454865", "Unverified apps", "The user limit")}
${ref("https://support.google.com/cloud/answer/13465431", "Security assessment", "Verification of restricted permissions")}
</ul>`,
)}
${section(
  "Responsibility for costs",
  `<p>The operator of ${a} is responsible for all costs of the Cloudflare account, the Google Cloud project and the other services that ${a} uses. Prices, allowances and limits can change at any time. Before you choose a plan, read the current pricing page of each provider.</p>
<p>This page is for information only. It can be incomplete or out of date.</p>
<p>The authors of the Mailroom software supply it under the <a href="https://github.com/karlvr/mailroom/blob/main/LICENSE" target="_blank" rel="noopener">MIT License</a>, “as is”, without warranty of any kind. The licence also states that the authors are not liable for any claim, damages or other liability in connection with the software. To the extent that the law permits, the authors are not liable for any cost, charge or fee from Cloudflare, Google or another provider.</p>`,
)}`,
    { app },
  );
}

export function releaseNotesPage(app: string) {
  const a = esc(app);
  const day = (date: string) =>
    new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  return page(
    "Release notes",
    `<h1>Release notes</h1>
<p class="lede">The changes to ${a} that you need to know about, newest first. When a change adds tools, an agent gets the new tools only after you reconnect ${a} in its app. <a href="/connect#new-tools">How to reconnect</a></p>
${RELEASE_NOTES.map((d) =>
  section(esc(day(d.date)), `<ul>${d.changes.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>`),
).join("\n")}`,
    { app },
  );
}

/** The name of the check box for each permission in the form of a mailbox. The form sends the value "1" when the box is selected. */
export const PERMISSION_FIELDS: Record<keyof AccountPermissions, string> = {
  sendEmail: "allow_send",
  sendInvitations: "allow_invite",
  rsvp: "allow_reply",
};

/** Returns the path of the history page of a context. The paths of the actions on that context start with it. */
export const contextHref = (s: ContextSubject) =>
  s.kind === "global" ? "/context" : `/accounts/${encodeURIComponent(s.accountId)}/context`;

/** Returns a time as a `<time>` element. The page script shows it in the time zone of the browser. */
const when = (ms: number) =>
  `<time datetime="${new Date(ms).toISOString()}">${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC</time>`;

/** Returns the name of the person or the agent that wrote a version, as HTML. `viewer` is the address of the signed-in user. */
function authorHtml(v: ContextVersion, viewer: string): string {
  if (v.author_kind === "user") return v.author.toLowerCase() === viewer.toLowerCase() ? "you" : esc(v.author);
  const host = clientHost(v.client_id);
  return `<b>${esc(v.author)}</b>${host ? ` <span class="muted">(${esc(host)})</span>` : ""}${
    v.agent_label ? ` · “${esc(v.agent_label)}”` : ""
  }`;
}

/** What the history knows about the versions around a version, for its description. */
interface ChangeRefs {
  /** Returns the number of a version in the history, or undefined when the history is not at hand. */
  number?: (id: number) => number | undefined;
  /** True when the user edited this proposal before it became current. */
  acceptedWithEdits?: boolean;
}

/** Returns who made a version current and when, as HTML, for example "Proposed by Claude, accepted by you on 10 Nov 2026". */
function changeHtml(v: ContextVersion, viewer: string, refs: ChangeRefs = {}): string {
  const at = when(v.decided_at ?? v.created_at);
  const decider = v.decided_by && v.decided_by.toLowerCase() === viewer.toLowerCase() ? "you" : esc(v.decided_by ?? "");
  const versionOf = (id: number) => {
    const n = refs.number?.(id);
    return n ? `version ${n}` : undefined;
  };
  if (v.author_kind === "agent") {
    return `Proposed by ${authorHtml(v, viewer)}, accepted ${refs.acceptedWithEdits ? "with edits " : ""}by ${decider} on ${at}`;
  }
  if (v.restored_from) {
    const from = versionOf(v.restored_from);
    return `Restored ${from ? `from ${from} ` : ""}by ${authorHtml(v, viewer)} on ${at}`;
  }
  if (v.edited_from) {
    const from = versionOf(v.edited_from);
    return `Edited by ${authorHtml(v, viewer)} from ${from ? `the proposal in ${from}` : "a proposal"} on ${at}`;
  }
  return `Changed by ${authorHtml(v, viewer)} on ${at}`;
}

const textHtml = (t: string) => (t ? esc(t) : `<span class="empty-text">The context is empty.</span>`);

/** Returns the changes from `before` to `after` as HTML, or the text when the two are the same. */
function contextDiffHtml(before: string, after: string): string {
  if (before === after) return textHtml(after);
  return diffWords(before, after)
    .map((r) => (r.op === "same" ? esc(r.text) : r.op === "removed" ? `<del>${esc(r.text)}</del>` : `<ins>${esc(r.text)}</ins>`))
    .join("");
}

/** Returns the changes from the current context to `text` as an HTML fragment, for the Diff tab of a proposal. */
export function contextPreview(current: string, text: string): Response {
  return new Response(contextDiffHtml(current, text.replace(/\r\n?/g, "\n")), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

/**
 * The script of the proposal on the history page. It shows the Diff and Edit tabs of the proposal,
 * gets a new diff from the preview URL after the user edits the text, and changes Accept to Accept
 * with edits while the text differs from the agent's text. The Edit button next to Accept opens the
 * Edit tab and scrolls up to the tabs. Without the script, the page shows the diff and the text box
 * together.
 */
const PROPOSAL_JS = `document.querySelectorAll('[data-proposal]').forEach(p=>{
const tabs=p.querySelector('[role=tablist]'),ta=p.querySelector('textarea'),diff=p.querySelector('[data-pane=diff]'),edit=p.querySelector('[data-pane=edit]'),accept=p.querySelector('[data-accept]'),revert=p.querySelector('[data-revert]'),editButton=p.querySelector('[data-edit]'),cap=p.querySelector('[data-caption]'),form=p.querySelector('form');
const original=ta.dataset.original,edited=()=>ta.value!==original;let shown=original;
const sync=()=>{accept.textContent=edited()?'Accept with edits':'Accept';revert.hidden=!edited()};
const show=async t=>{
tabs.querySelectorAll('[role=tab]').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.tab===t)));
edit.hidden=t!=='edit';diff.hidden=t!=='diff';editButton.hidden=t==='edit';
cap.textContent=t==='edit'?'Edit the text before you accept it':edited()?'Changes from the current context, with your edits':'Changes from the current context';
if(t==='edit'){ta.focus({preventScroll:true});return}
if(ta.value===shown)return;
const v=ta.value,r=await fetch(p.dataset.preview,{method:'POST',body:new URLSearchParams({csrf:form.elements.csrf.value,context:v})});
if(r.ok){diff.innerHTML=await r.text();shown=v}
};
tabs.hidden=false;
tabs.addEventListener('click',e=>{const b=e.target.closest('[role=tab]');if(b)show(b.dataset.tab)});
ta.addEventListener('input',sync);
revert.addEventListener('click',()=>{ta.value=original;sync();show('diff')});
editButton.addEventListener('click',()=>{show('edit');tabs.parentElement.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'})});
show('diff');
})`;

/** Returns a warning that names the agent connections with an old tool list, or nothing when there are none. */
function outdatedHtml(app: string, connections: readonly AgentConnection[]): string {
  if (!connections.length) return "";
  const a = esc(app);
  const names = connections
    .map((c) => {
      const host = clientHost(c.clientId);
      return `<b>${esc(c.name)}</b>${host ? ` (${esc(host)})` : ""}`;
    })
    .join(", ");
  const which = connections.length === 1 ? "This agent connection has" : "These agent connections have";
  return warning(
    `${a} has new or changed tools. ${which} the old tools: ${names}. To get the new tools, reconnect ${a} in the app. <a href="/connect#new-tools">How to reconnect</a> · <a href="/release-notes">What changed</a>`,
  );
}

/** Returns the line under a context: when the context changed, by whom, and a link to its history. */
function contextMeta(subject: ContextSubject, summary: ContextSummary | null | undefined, viewer: string): string {
  if (!summary?.latest) return "";
  const versions = `${summary.versions} ${summary.versions === 1 ? "version" : "versions"}`;
  return `<p class="ctx-meta">${changeHtml(summary.latest, viewer)} · <a href="${contextHref(subject)}">History (${versions})</a></p>`;
}

/** Returns the band that shows that a proposal for a context waits for the user. */
const proposalBand = (subject: ContextSubject) =>
  `<div class="band"><span class="label">Proposal waiting</span><p>An agent proposed a change to the context. The context changes only when you accept it.</p><a class="btn" href="${contextHref(subject)}#proposal">Review the proposal${ICON.arrow}</a></div>`;

/** Returns the navigation of the pages for a signed-in user. `current` is the page that shows it, if it is one of them. */
const userNav = (current?: "mailboxes" | "connect"): NavLink[] => [
  { href: "/", text: "Mailboxes", current: current === "mailboxes" },
  { href: "/connect", text: "Connect an agent", current: current === "connect" },
];

/** Returns the start of a context for a one-line preview. */
function contextPreviewLine(context: string): string {
  const line = context.split("\n").find((l) => l.trim())?.trim() ?? "";
  return line.length > 90 ? `${line.slice(0, 90)}…` : line;
}

export function dashboardPage(
  app: string,
  who: string,
  accounts: Account[],
  contexts: ContextSummaries,
  csrf: string,
  notices: {
    /** The messages to show at the top of the page. */
    messages?: readonly MessageCode[];
    /** True when this version has setup steps that the admin did not complete. */
    setupOutdated?: boolean;
    /** The agent connections that do not have the current tool list. */
    outdatedConnections?: readonly AgentConnection[];
    /** The ID of the mailbox that the user linked a moment ago. The page puts the cursor in its first empty field. */
    linkedMailbox?: string;
  } = {},
) {
  const a = esc(app);
  const subject = (m: Account): ContextSubject => ({ kind: "account", accountId: m.id });
  const hasProposal = (m: Account) => contexts.accounts.get(m.id)?.hasProposal ?? false;
  /** Returns true when a mailbox has no short name or no context notes. */
  const needsSetup = (m: Account) => !m.name || !m.context;
  // Each mailbox starts collapsed, unless it is the only one or it needs setup.
  const opened = (m: Account) => accounts.length === 1 || needsSetup(m);
  const can = (text: string) => `<div class="r"><span>${text}</span><span class="v">${ICON.check}Allowed</span></div>`;
  /** The short text of the pill that shows that a permission is on. */
  const permissionPills: Record<keyof AccountPermissions, string> = {
    sendEmail: "Sending on",
    sendInvitations: "Invitations on",
    rsvp: "RSVP on",
  };
  const permissionHelp: Record<keyof AccountPermissions, string> = {
    sendEmail: "Agents can send email from this mailbox.",
    sendInvitations: "Agents can invite guests to events, and change or delete events that have other guests. Google emails each guest.",
    rsvp: "Agents can accept, decline or tentatively accept invitations. Google tells the organizer.",
  };
  const permissionKeys = Object.keys(PERMISSION_FIELDS) as (keyof AccountPermissions)[];
  const acct = (m: Account, i: number) => {
    const id = esc(m.id);
    const relink = `/accounts/link?hint=${encodeURIComponent(m.email)}`;
    const permissions = accountPermissions(m);
    const calendar = hasCalendar(grantedScopes(m));
    // After a link, the cursor goes to the first empty field of the new mailbox.
    const focus = m.id === notices.linkedMailbox ? (m.name ? "context" : "name") : null;
    const onPills = permissionKeys
      .filter((k) => permissions[k])
      .map((k) => `<span class="pill send">${ICON.send}${permissionPills[k]}</span>`)
      .join("");
    const toggle = (k: keyof AccountPermissions) => {
      const field = PERMISSION_FIELDS[k];
      return `<label class="toggle" for="${field}-${id}">${esc(PERMISSION_LABELS[k])}<input id="${field}-${id}" type="checkbox" name="${field}" value="1"${permissions[k] ? " checked" : ""}></label>
<p class="help">${permissionHelp[k]}</p>`;
    };
    return `<details class="mbx" id="mbx-${id}"${opened(m) ? " open" : ""}>
<summary><span class="id${m.status === "ok" ? "" : " warn"}">${mailboxId(i + 1)}</span>
<span class="who"><b>${esc(m.name || m.email)}</b>${m.name ? `<span>${esc(m.email)}</span>` : ""}</span>
<span class="pills">${needsSetup(m) ? `<span class="pill warn">Needs setup</span>` : ""}${
      m.status === "ok" ? `<span class="pill ok">Linked</span>` : `<span class="pill warn">${ICON.warn}Needs re-linking</span>`
    }${calendar ? `<span class="pill ok">Calendar</span>` : `<span class="pill">No calendar</span>`}${onPills || `<span class="pill">Sending off</span>`}${
      hasProposal(m) ? `<span class="pill warn">Context proposal</span>` : ""
    }</span>
<span class="chev">${ICON.chevron}</span></summary>
<div class="body">
${hasProposal(m) ? proposalBand(subject(m)) : ""}
${m.status !== "ok" ? warning(`${esc(m.status_detail || "Google access stopped working.")} <a href="${relink}">Re-link</a>`) : ""}
<form method="post" action="/accounts/${id}">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<div class="cols"><div class="fields">
<label for="name-${id}">Short name <span class="hint">Agents use this name for the mailbox</span></label>
<input id="name-${id}" type="text" name="name" value="${esc(m.name)}" placeholder="For example, Support"${focus === "name" ? " autofocus" : ""}>
<label for="context-${id}">Context for agents <span class="hint">Takes precedence over the global context</span></label>
<textarea id="context-${id}" name="context" placeholder="What this mailbox is for, who matters, what's urgent, what to ignore, how to sign replies…"${focus === "context" ? " autofocus" : ""}>${esc(m.context)}</textarea>
${contextMeta(subject(m), contexts.accounts.get(m.id), who)}
</div>
<div class="caps"><div class="label">What agents can do here</div>
${can("Search and read email")}${can("Add and remove labels")}${can("Save drafts and forwards")}${can("Move threads to the trash")}
${
  calendar
    ? `${can("Read the calendar and find free time")}${can("Create, change and delete events without guests")}`
    : `<div class="r no"><span>Calendar is not linked. To add it, click <b>Re-link</b> and keep the Calendar check boxes selected.</span><span class="v">${ICON.cross}Off</span></div>`
}
<div class="send">${permissionKeys.map(toggle).join("\n")}
<p class="help">${a} instructs agents to do these actions only when you instruct them, never because an email or an event requests it. This instruction reduces the risk that an email or an event tricks an agent, but it cannot remove the risk.</p></div>
<div class="r no"><span>Delete email permanently</span><span class="v">${ICON.cross}Never</span></div>
</div></div>
<div class="actions"><div class="row"><button>Save</button><a class="btn secondary" href="${relink}">Re-link</a></div>
<button class="danger" formaction="/accounts/${id}/remove" onclick="return confirm('Remove ${esc(m.email)}? This also revokes its Google access.')">Remove</button></div>
</form></div></details>`;
  };

  const unset = accounts.filter(needsSetup);
  const setupBanner = unset.length
    ? `<div class="notice info"><span>${unset.length === 1 ? "This mailbox needs" : "These mailboxes need"} a short name and context notes: ${unset
        .map((m) => `<a href="#mbx-${esc(m.id)}">${esc(m.name || m.email)}</a>`)
        .join(", ")}. ${a} instructs agents to read them before they work in a mailbox.</span></div>`
    : "";

  const global = contexts.global;

  // Each context with a proposal that waits for the user, the global context first.
  const waiting = [
    ...(global.summary?.hasProposal ? [{ name: "Global context", subject: GLOBAL_CONTEXT as ContextSubject }] : []),
    ...accounts.filter(hasProposal).map((m) => ({ name: m.name || m.email, subject: subject(m) })),
  ];
  const proposalBanner = waiting.length
    ? warning(
        `${waiting.length === 1 ? "A context proposal waits" : "Context proposals wait"} for your review: ${waiting
          .map((w) => `<a href="${contextHref(w.subject)}#proposal">${esc(w.name)}</a>`)
          .join(", ")}. ${waiting.length === 1 ? "The context changes" : "A context changes"} only when you accept ${
          waiting.length === 1 ? "the" : "its"
        } proposal.`,
      )
    : "";

  const globalPreview = contextPreviewLine(global.context);
  const globalHtml = `<details class="mbx" id="global-context">
<summary><span class="id">ALL</span>
<span class="who"><b>Global context</b><span>${globalPreview ? esc(globalPreview) : "Empty. Add the notes that apply to every mailbox."}</span></span>
<span class="pills">${global.summary?.hasProposal ? `<span class="pill warn">Context proposal</span>` : ""}</span>
<span class="chev">${ICON.chevron}</span></summary>
<div class="body">
${global.summary?.hasProposal ? proposalBand(GLOBAL_CONTEXT) : ""}
<form method="post" action="${contextHref(GLOBAL_CONTEXT)}">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<div class="cols"><div class="fields">
<label for="context-global">Global context for agents <span class="hint">Applies to every mailbox</span></label>
<textarea id="context-global" name="context" placeholder="Who you are, what you work on, your priorities, how you write…">${esc(global.context)}</textarea>
${contextMeta(GLOBAL_CONTEXT, global.summary, who)}
</div>
<div class="caps"><div class="label">How agents use it</div>
<div class="r"><span>Agents follow the global context in every mailbox.</span></div>
<div class="r"><span>Where the context of a mailbox conflicts with the global context, agents follow the context of the mailbox.</span></div>
<div class="r"><span>Put notes about one mailbox in the context of that mailbox.</span></div>
<div class="r"><span>An agent can only propose a change. The global context changes only when you accept it.</span></div>
</div></div>
<div class="actions"><div class="row"><button>Save</button></div></div>
</form></div></details>`;

  return page(
    "Mailboxes",
    `${messagePanels(app, notices.messages ?? [])}
${
  notices.setupOutdated
    ? warning(`This version of ${a} needs a new setup step. The admin must open the <a href="/setup">setup page</a> and do the steps marked New. Until then, some tools can fail.`)
    : ""
}
${proposalBanner}
${outdatedHtml(app, notices.outdatedConnections ?? [])}
${setupBanner}
<section class="sect" id="mailboxes">
<div class="rule"><span class="n">01</span><span>Mailboxes</span><span class="end">${accounts.length} linked</span></div>
<div class="title"><div><h1>Your mailboxes</h1>
<p class="lede">Link each Gmail or Workspace mailbox. Agents can use these mailboxes and their calendars only through ${a}. Agents can label, draft and trash email, and create and change events. Agents can send email, send calendar invitations and RSVP to invitations only where you allow it.</p></div>
<div class="row"><a class="btn" href="/accounts/link">${ICON.plus}Link a mailbox</a><a class="btn secondary" href="/connect">Connect an agent</a></div></div>
<div class="panel raised ticks register">${
      accounts.length
        ? `${accounts.map(acct).join("")}<p class="note">${a} instructs agents to read the global context and the context notes of a mailbox before they work in that mailbox.</p>`
        : `<div class="empty">${motif()}<p>You have no linked mailboxes.</p><a class="btn secondary" href="/accounts/link">Link your first mailbox</a></div>`
    }</div>
</section>

<section class="sect" id="global">
<div class="rule"><span class="n">02</span><span>Global context</span><span class="end">Every mailbox</span></div>
<div class="panel raised ticks register">${globalHtml}</div>
</section>`,
    { app, width: "wide", nav: userNav("mailboxes"), aside: signedIn(who) },
  );
}

export function connectPage(app: string, origin: string, who: string) {
  const a = esc(app);
  const url = `${origin}/mcp`;
  // The name of the MCP server in the commands of the terminal apps.
  const server = app.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "mailroom";
  const steps = (items: string[]) => `<ol class="steps">${items.map((i) => `<li><div>${i}</div></li>`).join("")}</ol>`;
  const signIn = `If the ${a} sign-in page opens, sign in with <b>${esc(who)}</b>. Then click <b>Allow</b> on the ${a} consent page.`;
  const agent = (n: string, id: string, title: string, end: string, items: string[], side: string) =>
    `<section class="sect" id="${id}"><div class="rule"><span class="n">${n}</span><span>${title}</span><span class="end">${end}</span></div>
<div class="panel connect">${steps(items)}<div class="side pad">${side}</div></div></section>`;
  return page(
    "Connect an agent",
    `<div class="rule"><span class="n">Connect</span><span>Agents</span><span class="end">MCP · OAuth</span></div>
<div class="title"><div><h1>Connect an agent</h1>
<p class="lede">Connect an AI agent to ${a}, so that it can use your mailboxes and calendars. Each app connects to the URL below and signs in to ${a}. The agent then has tools for every mailbox that you link. It can search and read email, apply labels, save drafts and forwards, trash threads, and read and change calendars. It can send email, send invitations and RSVP to invitations only where you allow it.</p>
${copyBox(url)}
<p class="help">Steps for: <a href="#claude">Claude</a> · <a href="#claude-code">Claude Code</a> · <a href="#codex">Codex</a> · <a href="#chatgpt">ChatGPT</a> · <a href="#new-tools">New tools</a></p></div></div>
${agent(
  "01",
  "claude",
  "Claude",
  "Web, desktop and mobile",
  [
    "In Claude, open <b>Customize → Connectors</b>.",
    "Click <b>+ Add</b>, then click <b>Add custom connector</b>.",
    `Enter <code>${a}</code> as the name and this URL as the URL:${copyBox(url)}`,
    "Click <b>Continue</b> until Claude shows the <b>Authentication</b> settings.",
    "Under <b>Authentication</b>, choose <b>Sign in now</b>. Then click <b>Add</b>.",
    "Click <b>Connect</b>.",
    signIn,
  ],
  `<div class="label">Team and Enterprise plans</div>
<p>An Owner adds the connector once in <b>Organization settings → Connectors</b>, with <b>Add → Custom → Web</b>. Then each person opens <b>Customize → Connectors</b> and clicks <b>Connect</b> next to ${a}.</p>`,
)}
${agent(
  "02",
  "claude-code",
  "Claude Code",
  "Terminal",
  [
    `In a terminal, run this command:${copyBox(`claude mcp add --transport http --scope user ${server} ${url}`)}`,
    "Start Claude Code, and run <code>/mcp</code>.",
    `Select <b>${esc(server)}</b>, and then choose <b>Authenticate</b>.`,
    signIn,
  ],
  `<div class="label">Projects</div>
<p>The command adds ${a} to all your projects. To add it only to the project in the current folder, remove <code>--scope user</code>.</p>`,
)}
${agent(
  "03",
  "codex",
  "Codex",
  "CLI, IDE extension and ChatGPT desktop app",
  [
    `In a terminal, run this command:${copyBox(`codex mcp add ${server} --url ${url}`)}`,
    `Run this command. Codex opens the ${a} sign-in page in your browser.${copyBox(`codex mcp login ${server}`)}`,
    signIn,
    "If you use Codex in the ChatGPT desktop app, restart the app.",
  ],
  `<div class="label">One setting for each computer</div>
<p>The Codex CLI, the Codex IDE extension and the ChatGPT desktop app use the same settings file, <code>~/.codex/config.toml</code>. Add ${a} once on each computer.</p>`,
)}
${agent(
  "04",
  "chatgpt",
  "ChatGPT",
  "Developer mode",
  [
    "In ChatGPT, open <b>Settings → Apps &amp; Connectors → Advanced settings</b>, and turn on <b>Developer mode</b>.",
    "In <b>Settings → Apps &amp; Connectors</b>, click <b>Create</b>.",
    `Enter <code>${a}</code> as the name and this URL as the connector URL:${copyBox(url)}`,
    "Choose <b>OAuth</b> as the authentication. Then click <b>Create</b>.",
    signIn,
    `In a chat, ask ChatGPT to use ${a}.`,
  ],
  `<div class="label">Plans</div>
<p>Developer mode is available on the Plus, Pro, Business, Enterprise and Edu plans. On a Business, Enterprise or Edu plan, an admin can need to allow custom connectors first.</p>
<p>OpenAI can change the names of these menus.</p>`,
)}
<section class="sect" id="new-tools"><div class="rule"><span class="n">05</span><span>New tools</span><span class="end">After an update</span></div>
<div class="panel pad doc">
<p>An app keeps the ${a} tools from the time that it connected. When ${a} adds or changes tools, the app gets them only after you reconnect ${a} in it. The Mailboxes page shows a warning for each connection that has the old tools, and the <a href="/release-notes">release notes</a> tell you what changed.</p>
<ul>
<li><b>Claude:</b> open <b>Customize → Connectors</b>, disconnect ${a}, and then connect it again.</li>
<li><b>Claude Code:</b> start Claude Code again.</li>
<li><b>Codex:</b> start Codex again. In the ChatGPT desktop app, restart the app.</li>
<li><b>ChatGPT:</b> open a new chat. If the new tools do not show, delete the ${a} connector in <b>Settings → Apps &amp; Connectors</b>, and then create it again.</li>
</ul></div></section>`,
    { app, width: "wide", nav: userNav("connect"), aside: signedIn(who) },
  );
}

export function consentPage(
  app: string,
  who: string,
  d: { clientName: string; clientDomain?: string; redirectHost: string; redirectIsLoopback: boolean },
  handle: string,
  accounts: Account[],
) {
  const a = esc(app);
  const marks = (m: Account) => {
    const p = accountPermissions(m);
    return [
      p.sendEmail ? `<span class="pill ok">Can send</span>` : "",
      p.sendInvitations ? `<span class="pill ok">Can invite</span>` : "",
      p.rsvp ? `<span class="pill ok">Can RSVP</span>` : "",
    ].join("");
  };
  const mailboxes =
    accounts
      .map(
        (m, i) =>
          `<li><span class="id">${mailboxId(i + 1)}</span><span class="who"><b>${esc(m.name || m.email)}</b>${
            m.name ? `<span>${esc(m.email)}</span>` : ""
          }</span>${marks(m)}</li>`,
      )
      .join("") || `<li class="muted">You have no linked mailboxes. The access also includes the mailboxes that you link later.</li>`;
  return page(
    "Allow access",
    `<div class="link" aria-hidden="true"><span class="ico">${ICON.client}</span><i></i><span class="via">OAuth</span><i></i>${mark(48)}</div>
<div class="panel raised ticks accent consent">
<div class="pad"><div class="label hot">Authorisation request</div>
<h1>Allow ${esc(d.clientName)} to use your mailboxes and calendars?</h1>
${d.redirectIsLoopback ? warning("That address is on your computer. Continue only if you started this connection from an app on your computer a moment ago.") : ""}</div>
<dl class="kv">
<div><dt class="label">App from</dt><dd>${d.clientDomain ? esc(d.clientDomain) : `Not verified<span class="muted">This app registered itself. ${a} cannot verify its name.</span>`}</dd></div>
<div><dt class="label">Access goes to</dt><dd>${esc(d.redirectHost)}</dd></div>
</dl>
<div class="grp"><div class="label">Mailboxes</div><ul class="mbl">${mailboxes}</ul></div>
<div class="grp sunk"><div class="label">In these mailboxes, the app can</div><div class="can">
<span>${ICON.check}Search and read email</span><span>${ICON.check}Label email</span><span>${ICON.check}Save drafts and forwards</span><span>${ICON.check}Move email to the trash</span>
<span>${ICON.check}Read calendars and find free time</span><span>${ICON.check}Create, change and delete events without guests</span>
<span>${ICON.send}Send email from a mailbox with the mark Can send</span><span>${ICON.send}Send calendar invitations from a mailbox with the mark Can invite</span>
<span>${ICON.send}RSVP to invitations for a mailbox with the mark Can RSVP</span><span>${ICON.check}Propose changes to the context, which you accept or reject</span><span class="no">${ICON.cross}Not delete email permanently</span>
</div></div>
<form method="post" action="/authorize" class="grp decide">
<input type="hidden" name="handle" value="${esc(handle)}">
<p class="muted">If you click <b>Allow</b>, ${a} sends the access to <b>${esc(d.redirectHost)}</b>. To revoke this access at any time, remove the connector in the app.</p>
<div class="row"><button name="decision" value="approve">Allow</button><button class="secondary" name="decision" value="deny">Deny</button></div>
</form></div>`,
    { app, width: "narrow", backdrop: "letter", aside: signedIn(who) },
  );
}

/** How the history page shows the selected version: its text, or its changes against another version. */
export type ContextCompare = "text" | "previous" | "next" | "current";

/** The context that a history page shows: the global context, or the context of one mailbox. */
export type ContextPageSubject = { kind: "global" } | { kind: "account"; account: Account };

/** The data of the history page of one context. */
export interface ContextPageData {
  /** The accepted versions, oldest first. */
  versions: ContextVersion[];
  /** The proposal that waits for a decision, or null. */
  proposal: ContextVersion | null;
  /** The version to show. The default is the current version. */
  selectedId?: number;
  compare: ContextCompare;
  csrf: string;
  /** The messages to show at the top of the page. */
  messages?: readonly MessageCode[];
}

export function contextPage(app: string, who: string, owner: ContextPageSubject, h: ContextPageData) {
  const a = esc(app);
  const base = contextHref(owner.kind === "global" ? GLOBAL_CONTEXT : { kind: "account", accountId: owner.account.id });
  const { versions } = h;
  const current = versions[versions.length - 1] as ContextVersion | undefined;
  const position = new Map(versions.map((v, i) => [v.id, i]));
  const number = (id: number) => (position.get(id) ?? -1) + 1;
  const csrf = `<input type="hidden" name="csrf" value="${esc(h.csrf)}">`;

  // A proposal that the user edited is followed by the version with the edits.
  const editedProposals = new Set(versions.map((v) => v.edited_from).filter((id): id is number => id !== null));
  const refs = (v: ContextVersion): ChangeRefs => ({
    number: (id) => number(id) || undefined,
    acceptedWithEdits: editedProposals.has(v.id),
  });
  const reasonHtml = (v: ContextVersion) => (v.reason ? `<p class="note"><b>Reason that the agent gave:</b> ${esc(v.reason)}</p>` : "");

  const proposalHtml = (p: ContextVersion) => {
    const stale = (current?.id ?? null) !== p.base_id;
    return `<div class="panel raised ticks accent proposal" data-proposal data-preview="${base}/preview">
<div class="pad"><div class="label hot">Proposal</div>
<p>${authorHtml(p, who)} proposed this change on ${when(p.created_at)}.</p>
${reasonHtml(p)}
${stale ? warning("The context changed after the agent made this proposal. The changes below compare the proposal with the current context. If you accept the proposal, it replaces the current context.") : ""}
</div>
<div class="cap"><span class="label" data-caption>Changes from the current context</span><span class="seg" role="tablist" aria-label="View" hidden><button type="button" role="tab" data-tab="diff" aria-selected="true">Diff</button><button type="button" role="tab" data-tab="edit" aria-selected="false">Edit</button></span></div>
<div class="diff" data-pane="diff">${contextDiffHtml(current?.context ?? "", p.context)}</div>
<form method="post" action="${base}/proposals/${p.id}">${csrf}
<div class="edit" data-pane="edit"><label for="proposal-${p.id}">Text of the proposal <span class="hint">You can edit it before you accept it</span></label>
<textarea id="proposal-${p.id}" name="context" maxlength="${MAX_CONTEXT_CHARS}" data-original="${esc(p.context)}">
${esc(p.context)}</textarea>
<p class="help">If you accept with edits, the history keeps the agent's text as one version and your text as the next version. Only your text becomes the current context.</p></div>
<div class="actions"><div class="row"><button name="decision" value="accept" data-accept>Accept</button><button type="button" class="secondary" data-edit hidden>Edit</button><button type="button" class="secondary" data-revert hidden>Revert to the agent's text</button><button class="secondary" name="decision" value="reject">Reject</button></div></div>
</form>
</div>`;
  };

  const selected = versions.find((v) => v.id === h.selectedId) ?? current;
  const none = owner.kind === "global" ? "You have no global context yet." : "This mailbox has no context yet.";
  let versionsHtml = `<div class="panel pad"><p>${none} You can enter it on the <a href="/">Mailboxes</a> page.</p></div>`;
  if (selected && current) {
    const i = position.get(selected.id)!;
    const previous = versions[i - 1];
    const next = versions[i + 1];
    const isCurrent = selected.id === current.id;
    const n = i + 1;
    const modes: { key: ContextCompare; label: string; available: boolean }[] = [
      { key: "text", label: "Text", available: true },
      { key: "previous", label: "Previous", available: !!previous },
      { key: "next", label: "Next", available: !!next },
      { key: "current", label: "Current", available: !isCurrent },
    ];
    const mode = modes.find((m) => m.key === h.compare && m.available)?.key ?? "text";
    const seg = modes
      .map((m) =>
        m.available
          ? `<a href="${base}?v=${selected.id}&amp;compare=${m.key}#versions"${m.key === mode ? ` aria-current="true"` : ""}>${m.label}</a>`
          : `<span>${m.label}</span>`,
      )
      .join("");
    const [caption, before, after] =
      mode === "previous"
        ? [`Changes from version ${n - 1} to version ${n}`, previous.context, selected.context]
        : mode === "next"
          ? [`Changes from version ${n} to version ${n + 1}`, selected.context, next.context]
          : mode === "current"
            ? [`Changes from version ${n} to the current version, version ${versions.length}`, selected.context, current.context]
            : [`Text of version ${n}`, selected.context, selected.context];
    const body = contextDiffHtml(before, after);
    const same = mode !== "text" && before === after ? ". The texts are the same." : "";
    const list = [...versions]
      .reverse()
      .map(
        (v) =>
          `<li><a href="${base}?v=${v.id}#versions"${v.id === selected.id ? ` aria-current="page"` : ""}><span class="n">Version ${number(v.id)}${
            v.id === current.id ? ` <span class="pill ok">Current</span>` : ""
          }</span><span class="m">${changeHtml(v, who, refs(v))}</span></a></li>`,
      )
      .join("");
    versionsHtml = `<div class="history"><div class="panel"><ul class="vlist">${list}</ul></div>
<div class="panel">
<div class="pad"><div class="label hot">Version ${n}${isCurrent ? " · Current" : ""}</div>
<p>${changeHtml(selected, who, refs(selected))}.</p>
${selected.author_kind === "agent" ? reasonHtml(selected) : ""}
${editedProposals.has(selected.id) ? `<p class="note">This text was never in effect. When you accepted the proposal, your edits in version ${n + 1} replaced it.</p>` : ""}</div>
<div class="cap"><span class="label">${caption}${same}</span><span class="seg" aria-label="Compare">${seg}</span></div>
<div class="diff">${body}</div>
${
  isCurrent
    ? ""
    : `<form method="post" action="${base}/versions/${selected.id}/restore" class="actions">${csrf}<div class="row"><button class="secondary">Restore version ${n}</button></div><span class="help">The text of version ${n} becomes the current context, as a new version.</span></form>`
}
</div></div>`;
  }

  return page(
    "Context history",
    `${messagePanels(app, h.messages ?? [])}
<div class="rule"><span class="n">Context</span><span>${owner.kind === "global" ? "Global" : esc(owner.account.name || owner.account.email)}</span><span class="end">${versions.length} ${versions.length === 1 ? "version" : "versions"}</span></div>
<div class="title"><div><h1>${owner.kind === "global" ? "Global context history" : "Context history"}</h1>
<p class="lede">${
      owner.kind === "global"
        ? `${a} instructs agents to follow the current global context in every mailbox. Where the context of a mailbox conflicts with it, agents follow the context of the mailbox.`
        : `${a} instructs agents to read the current context of <b>${esc(owner.account.email)}</b> before they work in this mailbox.`
    } An agent can only propose a change. The context changes only when you accept the proposal. The name of the app comes from the agent connection that you approved. The agent gives its own name, in quotes, and its reason. ${a} cannot verify them.</p></div>
<a class="btn secondary" href="/">Back to mailboxes</a></div>
${
  h.proposal
    ? `<section class="sect" id="proposal"><div class="rule"><span class="n">01</span><span>Proposal</span><span class="end">Waits for you</span></div>
${proposalHtml(h.proposal)}</section>`
    : ""
}
<section class="sect" id="versions"><div class="rule"><span class="n">${h.proposal ? "02" : "01"}</span><span>Versions</span><span class="end">Newest first</span></div>
${versionsHtml}
</section>
${h.proposal ? `<script>${PROPOSAL_JS}</script>` : ""}`,
    { app, width: "wide", nav: userNav(), aside: signedIn(who) },
  );
}
