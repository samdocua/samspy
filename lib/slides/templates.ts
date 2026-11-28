// SamSpy — «Слайды», mode «Вписать в картинку»: the template photos and where text goes on each
//
// Every template (public/slide-templates/<id>.jpg, 1152×1536) has one writable surface:
//   quad  — a flat surface: its 4 corners (tl, tr, br, bl) + insets (share of each side kept
//           free); text follows the surface's perspective (a sign, a card, a box)
//   mask  — a shape (heart, oval, tag…): lines take the shape's width at their height, all on one
//           axis; margin = free border (px); keep = the vertical part of the shape used (0..1);
//           angle = tilt of the object (°, − = rising to the right)
//   cyl   — a label on a cylinder (cup, mug): [axis x, radius, label top, label bottom, label left,
//           label right, how far the top / bottom edge dips in the middle]; fill = share of the arc
// color = text colour (dark → multiplied into the surface, light → drawn over it); chalk = chalky.
// Marked up by hand with Ham on 2026-11-28 (every template checked with a long question).
//
// pickTemplates(): random ones without repeats in a carousel, those not yet used in downloaded
// carousels first (memory in localStorage, like the photos from a folder).
//
// Version history:
//   v0.1.0 (2026-11-28) — initial: 29 templates.

export type Pt = [number, number];

export type TemplateGeom =
  | { kind: 'quad'; quad: Pt[]; inset: number[]; color: string; chalk?: boolean }
  | {
      kind: 'mask';
      shape: { rect: number[] } | { ellipse: number[] } | { poly: number[][] };
      margin: number;
      keep: number[];
      angle: number;
      color: string;
    }
  | { kind: 'cyl'; cyl: number[]; fill: number; color: string };

export interface SlideTemplate {
  id: string;
  g: TemplateGeom;
}

export const TEMPLATE_W = 1152;
export const TEMPLATE_H = 1536;

export const TEMPLATES: SlideTemplate[] = [
  { id: '01', g: {"kind":"mask","shape":{"rect":[250,380,900,830]},"margin":0,"keep":[0,1],"angle":0,"color":"#ffffff"} },
  { id: '02', g: {"kind":"mask","shape":{"poly":[[829,449],[797,442],[752,443],[716,452],[688,464],[645,492],[608,526],[564,591],[555,584],[513,528],[467,497],[412,476],[363,475],[310,496],[262,530],[225,576],[202,624],[188,687],[185,763],[192,813],[203,851],[232,914],[298,1006],[345,1058],[547,1249],[562,1249],[614,1203],[715,1106],[779,1037],[816,990],[865,915],[895,856],[911,815],[930,740],[934,708],[934,653],[925,576],[911,524],[895,496],[862,464]]},"margin":45,"keep":[0.2,0.72],"angle":-4.6,"color":"#af2328"} },
  { id: '03', g: {"kind":"cyl","cyl":[640,262,500,1030,388,900,6,22],"fill":0.82,"color":"#281e14"} },
  { id: '04', g: {"kind":"mask","shape":{"ellipse":[680,742,235,215]},"margin":0,"keep":[0,1],"angle":0,"color":"#962846"} },
  { id: '05', g: {"kind":"quad","quad":[[364.8,483.4],[795.1,480.7],[799.1,965.7],[374.3,961.8]],"inset":[0,0,0,0],"color":"#262220"} },
  { id: '06', g: {"kind":"quad","quad":[[150,368],[1000,374],[994,1064],[150,1064]],"inset":[0.13,0.15,0.13,0.17],"color":"#261e18"} },
  { id: '07', g: {"kind":"quad","quad":[[269,533],[941,566],[950,936],[269,917]],"inset":[0.07,0.12,0.07,0.12],"color":"#262220"} },
  { id: '08', g: {"kind":"quad","quad":[[264,360],[970,343],[960,1104],[257,1092]],"inset":[0.12,0.12,0.12,0.12],"color":"#262220"} },
  { id: '09', g: {"kind":"quad","quad":[[375.2,354.4],[844.6,376.5],[808.8,1135.6],[339.4,1113.5]],"inset":[0,0,0,0],"color":"#f5f5f0","chalk":true} },
  { id: '10', g: {"kind":"mask","shape":{"rect":[330,520,830,980]},"margin":10,"keep":[0,1],"angle":0,"color":"#1e1e1e"} },
  { id: '11', g: {"kind":"quad","quad":[[216,516],[924,432],[965,1159],[396,1284]],"inset":[0.12,0.14,0.1,0.12],"color":"#262220"} },
  { id: '12', g: {"kind":"quad","quad":[[211,439],[845,427],[960,1368],[84,1404]],"inset":[0.14,0.12,0.12,0.12],"color":"#f6ecde"} },
  { id: '13', g: {"kind":"quad","quad":[[96,372],[989,269],[1128,1128],[125,1260]],"inset":[0.12,0.14,0.12,0.14],"color":"#262220"} },
  { id: '14', g: {"kind":"mask","shape":{"rect":[330,600,860,960]},"margin":0,"keep":[0,1],"angle":0,"color":"#c8466e"} },
  { id: '15', g: {"kind":"cyl","cyl":[526,300,560,1180,240,815,10,40],"fill":0.75,"color":"#282422"} },
  { id: '16', g: {"kind":"quad","quad":[[307,492],[1001,653],[864,1123],[235,912]],"inset":[0.08,0.12,0.08,0.12],"color":"#262220"} },
  { id: '17', g: {"kind":"quad","quad":[[361,528],[1022,547],[1011,697],[360,691]],"inset":[0.05,0.12,0.05,0.12],"color":"#262220"} },
  { id: '18', g: {"kind":"quad","quad":[[0.0,0.0],[1151.0,0.0],[1151.0,1535.0],[0.0,1535.0]],"inset":[0.12,0.12,0.12,0.12],"color":"#262220"} },
  { id: '19', g: {"kind":"quad","quad":[[283,427],[917,437],[912,1440],[300,1435]],"inset":[0.12,0.26,0.1,0.3],"color":"#262220"} },
  { id: '20', g: {"kind":"quad","quad":[[80.0,483.2],[1030.5,461.2],[1046.2,1139.6],[95.7,1161.6]],"inset":[0.1,0.14,0.1,0.14],"color":"#262220"} },
  { id: '21', g: {"kind":"mask","shape":{"poly":[[100,660],[140,480],[240,380],[340,350],[460,370],[580,440],[700,370],[840,356],[960,400],[1030,500],[1060,660],[1020,840],[900,1000],[720,1160],[570,1280],[460,1200],[260,960],[140,800]]},"margin":75,"keep":[0.14,0.72],"angle":0,"color":"#3c3232"} },
  { id: '22', g: {"kind":"mask","shape":{"ellipse":[594,640,330,380]},"margin":20,"keep":[0.1,0.9],"angle":0,"color":"#ffffff"} },
  { id: '23', g: {"kind":"quad","quad":[[127,491],[573,496],[581,1300],[33,1296]],"inset":[0.13,0.18,0.1,0.18],"color":"#262220"} },
  { id: '24', g: {"kind":"quad","quad":[[141,556],[1037,556],[1023,1301],[143,1303]],"inset":[0.13,0.16,0.13,0.24],"color":"#261e18"} },
  { id: '25', g: {"kind":"mask","shape":{"poly":[[480,539],[621,528],[763,630],[809,1090],[387,1130],[355,660]]},"margin":40,"keep":[0.15,0.85],"angle":-4.5,"color":"#2d231c"} },
  { id: '27', g: {"kind":"quad","quad":[[160,234],[1040,280],[1030,1150],[170,1176]],"inset":[0.12,0.15,0.12,0.2],"color":"#262220"} },
  { id: '28', g: {"kind":"quad","quad":[[356.0,290.0],[819.0,288.0],[821.0,1131.0],[357.0,1133.0]],"inset":[0.12,0.12,0.12,0.12],"color":"#262220"} },
  { id: '29', g: {"kind":"mask","shape":{"poly":[[891,320],[831,308],[779,308],[726,320],[687,337],[648,362],[620,385],[585,423],[559,423],[531,393],[479,352],[437,330],[371,313],[297,317],[241,335],[208,353],[177,376],[136,424],[118,457],[103,497],[94,560],[96,622],[112,687],[144,766],[181,830],[225,895],[280,966],[291,965],[298,959],[329,959],[344,969],[356,989],[384,1087],[390,1089],[390,1103],[398,1104],[401,1121],[496,1232],[570,1328],[580,1326],[667,1219],[808,1066],[903,951],[943,896],[994,815],[1028,749],[1050,691],[1066,616],[1068,557],[1060,497],[1049,465],[1023,417],[996,384],[956,352]]},"margin":75,"keep":[0.16,0.66],"angle":0,"color":"#3c282d"} },
  { id: '30', g: {"kind":"quad","quad":[[0.0,0.0],[1151.0,0.0],[1151.0,1535.0],[0.0,1535.0]],"inset":[0.12,0.12,0.12,0.12],"color":"#2d2622"} },
];

export const templateSrc = (id: string) => `/slide-templates/${id}.jpg`;
export const templateById = (id: string | null | undefined) => TEMPLATES.find((t) => t.id === id) ?? null;

// --- which templates were already used (downloaded carousels) -----------------------------
const USED_KEY = 'samspy.slides.templatesUsed.v1';

export function usedTemplates(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(USED_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

export function markTemplatesUsed(ids: string[]) {
  const s = usedTemplates();
  for (const id of ids) s.add(id);
  // all used → start over (keep only the ones just used)
  const next = s.size >= TEMPLATES.length ? new Set(ids) : s;
  try {
    localStorage.setItem(USED_KEY, JSON.stringify(Array.from(next)));
  } catch {
    /* storage off */
  }
}

export function clearUsedTemplates() {
  try {
    localStorage.removeItem(USED_KEY);
  } catch {
    /* storage off */
  }
}

const shuffle = <T,>(a: T[]) => {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
};

/** `n` random template ids, none of `taken` (other slides), not-yet-used ones first. */
export function pickTemplates(n: number, taken: Set<string>, used: Set<string>): string[] {
  const free = TEMPLATES.map((t) => t.id).filter((id) => !taken.has(id));
  const fresh = shuffle(free.filter((id) => !used.has(id)));
  const old = shuffle(free.filter((id) => used.has(id)));
  const order = [...fresh, ...old];
  // more slides than templates: start the cycle again (repeats only then)
  const out: string[] = [];
  while (out.length < n) out.push(...(order.length ? order : shuffle(TEMPLATES.map((t) => t.id))));
  return out.slice(0, n);
}
