// Позы упражнений: исходное положение и ключевое положение. Вид сбоку, человек смотрит вправо.
// Пол — y = 262. Все числа проверены визуально (npm run figures → e2e/screens/figures.png).
import type { Pose, Pt } from './skeleton';

export const FLOOR = 262;

export interface Arrow { pts: Pt[] }
export interface FigureDef {
  frames: [Pose, Pose];
  props?: 'mat' | 'stepper' | null;
  /** Педали мини-степпера: высота переднего края [ближняя, дальняя] для каждого кадра. */
  pedals?: [[number, number], [number, number]];
  arrows?: [Arrow[], Arrow[]];
  guides?: [Arrow[], Arrow[]];
}

const FWD: Pt = [1, 0];
const BACK: Pt = [-1, 0];
const UP: Pt = [0, -1];
const DOWN: Pt = [0, 1];

const standLegs = (x = 200, spread = 6): Pose['legs'] => [
  { target: [x + 2, FLOOR - 8], hint: FWD },
  { target: [x - spread, FLOOR - 8], hint: FWD },
];

// ------------------------------------------------------------------ присед с гирей у груди

const goblet: FigureDef = {
  frames: [
    {
      hip: [200, 136], torso: -90, legs: standLegs(), feet: [0, 0],
      arms: [{ target: [224, 92], hint: [0.2, 1] }, { target: [220, 92], hint: [0.2, 1] }],
      bell: { at: [229, 110] },
    },
    {
      hip: [168, 210], torso: -58, legs: [{ target: [202, FLOOR - 8], hint: FWD }, { target: [196, FLOOR - 8], hint: FWD }], feet: [0, 0],
      arms: [{ target: [236, 160], hint: [0.3, 1] }, { target: [232, 160], hint: [0.3, 1] }],
      bell: { at: [242, 178] },
    },
  ],
  arrows: [
    [{ pts: [[150, 120], [128, 160], [138, 200]] }],
    [{ pts: [[118, 232], [118, 190], [118, 150]] }],
  ],
  guides: [[], [{ pts: [[160, 222], [222, 120]] }]],
};

// ------------------------------------------------------------------ тяга гири к поясу одной рукой

const row: FigureDef = {
  frames: [
    {
      hip: [176, 150], torso: -32,
      legs: [{ target: [166, FLOOR - 8], hint: FWD }, { target: [236, FLOOR - 8], hint: FWD }], feet: [0, 0],
      arms: [{ target: [246, 200], hint: BACK }, { target: [228, 188], hint: [0.4, 1] }],
      bell: { at: [247, 218] },
    },
    {
      hip: [176, 150], torso: -32,
      legs: [{ target: [166, FLOOR - 8], hint: FWD }, { target: [236, FLOOR - 8], hint: FWD }], feet: [0, 0],
      arms: [{ target: [198, 160], hint: [-0.2, -1] }, { target: [228, 188], hint: [0.4, 1] }],
      bell: { at: [199, 178] },
    },
  ],
  arrows: [
    [{ pts: [[272, 214], [272, 192], [272, 168]] }],
    [{ pts: [[256, 222], [240, 196], [218, 192]] }],
  ],
  guides: [[{ pts: [[160, 138], [270, 70]] }], [{ pts: [[160, 138], [270, 70]] }]],
};

// ------------------------------------------------------------------ отжимания

const pushUp: FigureDef = {
  frames: [
    {
      hip: [199, 198], torso: -24.5,
      legs: [{ target: [90, 248], hint: DOWN }, { target: [92, 248], hint: DOWN }], feet: [62, 62],
      arms: [{ target: [270, 254], hint: BACK }, { target: [262, 254], hint: BACK }],
    },
    {
      hip: [209, 233], torso: -7,
      legs: [{ target: [90, 248], hint: DOWN }, { target: [92, 248], hint: DOWN }], feet: [62, 62],
      arms: [{ target: [270, 254], hint: [-1, -0.7] }, { target: [262, 254], hint: [-1, -0.7] }],
    },
  ],
  arrows: [
    [{ pts: [[232, 130], [232, 152], [232, 176]] }],
    [{ pts: [[236, 196], [236, 172], [236, 148]] }],
  ],
  guides: [[{ pts: [[80, 252], [312, 146]] }], [{ pts: [[80, 251], [328, 219]] }]],
};

// ------------------------------------------------------------------ ягодичный мостик

const bridge: FigureDef = {
  props: 'mat',
  frames: [
    {
      hip: [218, 247], torso: 180, head: [116, 246],
      legs: [{ target: [252, 254], hint: UP }, { target: [256, 254], hint: UP }], feet: [0, 0],
      arms: [{ target: [226, 252], hint: UP }, { target: [222, 252], hint: UP }],
    },
    {
      hip: [213, 221], torso: 160, head: [116, 246],
      legs: [{ target: [252, 254], hint: UP }, { target: [256, 254], hint: UP }], feet: [0, 0],
      arms: [{ target: [226, 252], hint: UP }, { target: [222, 252], hint: UP }],
    },
  ],
  arrows: [
    [{ pts: [[214, 228], [214, 210], [214, 190]] }],
    [{ pts: [[200, 196], [200, 178], [200, 160]] }],
  ],
  guides: [[], [{ pts: [[128, 252], [290, 193]] }]],
};

// ------------------------------------------------------------------ планка на предплечьях

const plank: FigureDef = {
  props: 'mat',
  frames: [
    {
      hip: [196, 232], torso: -21,
      legs: [{ target: [80, 250], hint: DOWN }, { target: [84, 250], hint: DOWN }], feet: [163, 163],
      arms: [{ target: [306, 251], hint: DOWN }, { target: [300, 251], hint: DOWN }],
    },
    {
      hip: [194, 222], torso: -11.7,
      legs: [{ target: [76, 246], hint: DOWN }, { target: [78, 246], hint: DOWN }], feet: [62, 62],
      arms: [{ target: [306, 251], hint: DOWN }, { target: [300, 251], hint: DOWN }],
    },
  ],
  guides: [[], [{ pts: [[66, 249], [316, 196]] }]],
};

// ------------------------------------------------------------------ румынская тяга

const rdl: FigureDef = {
  frames: [
    {
      hip: [200, 136], torso: -90, legs: standLegs(), feet: [0, 0],
      arms: [{ target: [208, 142], hint: BACK }, { target: [204, 142], hint: BACK }],
      bell: { at: [209, 160] },
    },
    {
      hip: [166, 142], torso: -24, legs: [{ target: [202, FLOOR - 8], hint: FWD }, { target: [196, FLOOR - 8], hint: FWD }], feet: [0, 0],
      arms: [{ target: [237, 196], hint: BACK }, { target: [233, 196], hint: BACK }],
      bell: { at: [238, 214] },
    },
  ],
  arrows: [
    [{ pts: [[166, 120], [146, 124], [128, 132]] }],
    [{ pts: [[126, 150], [126, 128], [140, 108]] }],
  ],
  guides: [[], [{ pts: [[150, 150], [262, 100]] }]],
};

// ------------------------------------------------------------------ жим гири лёжа на полу

const floorPress: FigureDef = {
  props: 'mat',
  frames: [
    {
      hip: [218, 247], torso: 180, head: [116, 246],
      legs: [{ target: [252, 254], hint: UP }, { target: [256, 254], hint: UP }], feet: [0, 0],
      arms: [{ target: [186, 208], hint: [1, 0.4] }, { target: [226, 252], hint: UP }],
      bell: { at: [170, 204] }, bellRot: 75,
    },
    {
      hip: [218, 247], torso: 180, head: [116, 246],
      legs: [{ target: [252, 254], hint: UP }, { target: [256, 254], hint: UP }], feet: [0, 0],
      arms: [{ target: [146, 162], hint: [1, 0] }, { target: [226, 252], hint: UP }],
      bell: { at: [130, 160] }, bellRot: 75,
    },
  ],
  arrows: [
    [{ pts: [[96, 214], [96, 192], [96, 170]] }],
    [{ pts: [[96, 160], [96, 182], [96, 204]] }],
  ],
};

// ------------------------------------------------------------------ выпады назад

const lunge: FigureDef = {
  frames: [
    {
      hip: [200, 136], torso: -90, legs: [{ target: [196, FLOOR - 8], hint: FWD }, { target: [204, FLOOR - 8], hint: FWD }], feet: [0, 0],
      arms: [{ target: [210, 140], hint: BACK }, { target: [206, 140], hint: BACK }],
    },
    {
      hip: [176, 188], torso: -88, legs: [{ target: [104, 246], hint: DOWN }, { target: [226, FLOOR - 8], hint: FWD }], feet: [58, 0],
      arms: [{ target: [186, 192], hint: BACK }, { target: [182, 192], hint: BACK }],
    },
  ],
  arrows: [
    [{ pts: [[188, 236], [150, 214], [112, 236]] }],
    [{ pts: [[132, 120], [132, 144], [132, 168]] }],
  ],
};

// ------------------------------------------------------------------ боковая планка

const sidePlank: FigureDef = {
  props: 'mat',
  frames: [
    {
      hip: [203, 246], torso: -30.8,
      legs: [{ target: [84, 251], hint: UP }, { target: [83, 248], hint: UP }], feet: [0, 0],
      arms: [{ target: [306, 252], hint: DOWN }, { target: [208, 232], hint: UP }],
    },
    {
      hip: [194, 224], torso: -13.4,
      legs: [{ target: [77, 251], hint: UP }, { target: [76, 248], hint: UP }], feet: [0, 0],
      arms: [{ target: [306, 252], hint: DOWN }, { target: [200, 212], hint: UP }],
    },
  ],
  arrows: [
    [{ pts: [[196, 226], [196, 206], [196, 186]] }],
    [],
  ],
  guides: [[], [{ pts: [[68, 253], [318, 194]] }]],
};

// ------------------------------------------------------------------ мини-степпер

const stepper: FigureDef = {
  props: 'stepper',
  pedals: [[244, 216], [216, 244]],
  frames: [
    {
      hip: [196, 116], torso: -88,
      legs: [{ target: [206, 231], hint: FWD }, { target: [208, 217], hint: FWD }], feet: [2, -12],
      arms: [{ target: [236, 120], hint: DOWN }, { target: [178, 128], hint: DOWN }],
    },
    {
      hip: [196, 116], torso: -88,
      legs: [{ target: [208, 217], hint: FWD }, { target: [206, 231], hint: FWD }], feet: [-12, 2],
      arms: [{ target: [178, 128], hint: DOWN }, { target: [236, 120], hint: DOWN }],
    },
  ],
  arrows: [
    [{ pts: [[268, 216], [268, 230], [268, 244]] }],
    [{ pts: [[268, 244], [268, 230], [268, 216]] }],
  ],
};

// ------------------------------------------------------------------ прогулка

const walk: FigureDef = {
  frames: [
    {
      hip: [200, 138], torso: -87,
      legs: [{ target: [238, FLOOR - 8], hint: FWD }, { target: [160, FLOOR - 12], hint: FWD }], feet: [-12, 30],
      arms: [{ target: [180, 142], hint: FWD }, { target: [226, 136], hint: DOWN }],
    },
    {
      hip: [200, 138], torso: -87,
      legs: [{ target: [160, FLOOR - 12], hint: FWD }, { target: [238, FLOOR - 8], hint: FWD }], feet: [30, -12],
      arms: [{ target: [226, 136], hint: DOWN }, { target: [180, 142], hint: FWD }],
    },
  ],
  arrows: [[{ pts: [[250, 70], [280, 70], [306, 70]] }], [{ pts: [[250, 70], [280, 70], [306, 70]] }]],
};

export const FIGURES: Record<string, FigureDef> = {
  goblet_squat: goblet,
  kb_row: row,
  push_up: pushUp,
  glute_bridge: bridge,
  plank,
  kb_rdl: rdl,
  kb_floor_press: floorPress,
  reverse_lunge: lunge,
  side_plank: sidePlank,
  stepper,
  walk,
};
