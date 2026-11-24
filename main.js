// =============================================================
// CanSat 組立ビューア
//   段階1：全部品を読み込んで完成状態を表示する
//   段階2：「部品を見る」モード（クリックで説明・分解表示・単独表示・半透明）
//   段階3：「組み立て」モード（手順1〜8。部品が飛んできて収まる）
//   段階4：「ミッション」モード（収納〜走行の7フェーズ。仮の形の機構を含む）
//
// 処理の流れ
//   1. data/*.json（部品表・各部品の位置・組み立て手順）を読む
//   2. models/ のSTLを1種類につき1回だけ読み込む（同じ部品はジオメトリを共有）
//   3. placements.json の回転・平行移動で、各部品を組み上がった位置に置く
//   4. 全部品をまとめた親グループを x軸まわりに −90° 回し、CADの「z が上」を
//      Three.js の「y が上」に合わせる
//   5. 地面・影・前後の目印を出し、OrbitControls で360°回せるようにする
//   6. モード（組み立て／部品を見る）ごとに、画面の表示と操作を切り替える
//
// 部品の位置の決め方（全モード共通）
//   表示する位置 = 組み上がった位置（base_matrix）を、offset（CAD座標のmm）だけずらしたもの
//   ・部品を見るモード：offset = 分解の向き × スライダーの量
//   ・組み立てモード　：offset = 取り付け方向 × 離す距離 → アニメーションで 0 に近づける
//   ・ミッションモード：部品は動かさず、部品をまとめた「機体グループ」ごと動かす
//
// ものの親子関係（CAD座標で置くものは、すべて model_root の中に入れる）
//   scene
//   └ model_root（x軸まわりに −90°。中はCAD座標：z が上）
//       ├ vehicle（機体グループ。ミッションモードで位置・向きを変える）
//       │   ├ 部品19個
//       │   └ 機体に付いて動く仮の形（エンベロープ・パラシュート・ニクロム線・テグス・スタビライザ）
//       └ キャリア（機体と一緒には動かない）
// =============================================================
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";

// ----- 定数（マジックナンバーに名前を付ける） -----
const PARTS_URL = "data/parts.json";
const PLACEMENTS_URL = "data/placements.json";
const STEPS_URL = "data/steps.json";
const MISSION_URL = "data/mission.json";
const MODELS_DIR = "models/";
// 版の番号：index.html で main.js を読むときに付けた ?v= の値（なければ空）。
// 部品のSTLの URL にも付けて、更新したときに古い一時保存が使われないようにする
const ASSET_VERSION = new URL(import.meta.url).searchParams.get("v") ?? "";
const VERSION_QUERY = ASSET_VERSION ? `?v=${encodeURIComponent(ASSET_VERSION)}` : "";
const PHOTOS_DIR = "photos/";

const GROUND_Z_MM = -93;          // 地面の高さ（CAD座標の z。タイヤの最下点）
const GROUND_SIZE_MM = 2000;      // 地面の格子の一辺（走行フェーズで機体が動き回れる広さ）
const GROUND_DIVISIONS = 80;      // 格子の分割数（2000/80 = 25mm ごと）
const MARKER_DISTANCE_MM = 150;   // 「前」「後ろ」の目印を置く距離（機体中心から）
const SHADOW_MAP_SIZE = 2048;     // 影の解像度
const CAMERA_FOV_DEG = 40;        // カメラの画角
const CAMERA_FIT_MARGIN = 1.6;    // 機体全体が収まるように引く倍率
// おすすめの視点は横長の画面（PC）に合わせて決めてある。縦長の画面（スマホ）では
// 左右が切れやすいので、横幅÷高さ がこの値より小さいときは、その分カメラを引く
const REFERENCE_ASPECT = 1.4;
const MAX_NARROW_VIEW_SCALE = 2.0; // 引く倍率の上限

// おすすめの視点（機体の前・左上から見下ろす）。CADの向きで「前 = −y」
// → Three.js では +z 側が前になる。方向だけ決め、距離は機体の大きさから計算する
const DEFAULT_VIEW_DIRECTION = new THREE.Vector3(0.9, 0.7, 1.2).normalize();

// 部品を見るモードの定数
const EXPLODE_SCALE = 1.5;          // 分解スライダー最大のとき、中心からの距離を何倍離すか
const EXPLODE_SLIDER_MAX = 100;     // 分解スライダーの最大値（index.html の max と合わせる）
const HIGHLIGHT_COLOR = 0xffa726;   // 選んだ部品を光らせる色（オレンジ）
const HIGHLIGHT_INTENSITY = 0.55;   // 光らせる強さ（0〜1）
const TRANSLUCENT_OPACITY = 0.2;    // 半透明にしたときの不透明度（0＝透明、1＝不透明）
const CLICK_TOLERANCE_PX = 5;       // これ以上マウスが動いたら「クリック」ではなく「回転のドラッグ」とみなす

// タッチパッドのピンチで拡大する定数（#22）
//   Chrome・Edge は、ピンチを「Ctrl 付きのホイール」として deltaY = −100 × ln(指を広げた倍率) で送ってくる。
//   OrbitControls はこれを普通のホイールと同じ量（100 で 5%）で扱うので、2倍に広げても約3.5%しか寄らない。
//   そこで Ctrl 付きのホイールだけは、送られてきた量から倍率を逆算して、そのまま寄せる
const PINCH_WHEEL_DELTA_PER_E = 100;  // deltaY がこの値のとき、倍率が e 倍（約2.7倍）になる
const MAX_PINCH_WHEEL_DELTA = 25;     // 1回のイベントで使う量の上限（Ctrl＋マウスのホイール1目盛り＝100 で飛ばないように）
const WHEEL_LINE_HEIGHT_PX = 40;      // ホイールの量が「行」の単位で来たとき（Firefox など）、1行を何pxとみなすか
const WHEEL_DELTA_PER_NOTCH = 100;    // 普通のマウスホイール1目盛りの deltaY（Chrome・Edge で表示倍率100%のとき）
const WHEEL_ZOOM_RATIO_PER_NOTCH = 0.95; // 1目盛りで、カメラと注視点の距離を何倍にするか（OrbitControls と同じ）
const MAX_WHEEL_NOTCHES = 3;          // 1回のイベントで使う目盛りの上限（勢いよく回しても飛びすぎないように）
const MIN_CAMERA_DISTANCE_MM = 20;    // カメラが注視点にこれ以上近づかない（機体の中に入り込んで戻れなくならないように）

// 組み立てモードの定数
const FLY_DISTANCE_MM = 80;         // 部品が飛んでくる前の位置（完成位置からの距離）。steps.json の distance で手順ごとに変えられる
const FLY_DURATION_S = 1.0;         // 部品が飛んできて収まるまでの時間
const CAMERA_MOVE_DURATION_S = 1.0; // おすすめの視点へ移るのにかける時間
const AUTO_ROTATE_DURATION_S = 8;   // 「完成」の手順で、機体を一回りさせるのにかける時間
const SECONDS_PER_MINUTE = 60;      // OrbitControls の autoRotateSpeed は「60秒で何周するか」で指定する
const REDUCED_MOTION_FACTOR = 0.2;  // 「動きを減らす」設定のとき、アニメーションの時間を何倍にするか
const MAX_FRAME_DT_S = 0.25;        // 1コマの時間の上限（タブを裏に回したあとなどに、動きが飛ばないようにする）

// ミッションモードの定数（形の寸法・高さなどの値は mission.json に置く）
const SUN_OFFSET = new THREE.Vector3(200, 400, 250);   // 影を作る光の位置（機体から見た位置。Three.js の座標）
const STOW_ROTATION = new THREE.Quaternion()           // キャリアの中での向き：機体の x（車軸）を上（z）に向ける
  .setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);
const FOLDED_CHUTE_SCALE = 0.025;   // たたんだパラシュートの大きさ（開いたときを1とした倍率）
const HEXAGON_CORNERS = 6;          // パラシュートの角の数（六角形）
const ENVELOPE_SEGMENTS = 24;       // エンベロープ（半円筒）の丸みの細かさ
const ENVELOPE_AWAY_SHIFT = new THREE.Vector3(0, 600, 250);   // 分離後にエンベロープが離れていく向きと距離（CAD座標）
const CHUTE_LEAN_SHIFT = new THREE.Vector3(0, 350, -300);     // 着地後にパラシュートが風で後ろへ倒れる量
const CHUTE_AWAY_SHIFT = new THREE.Vector3(0, 900, 0);        // 分離後にパラシュートが離れていく量（エンベロープの分に加える）
const NICHROME_RADIUS_MM = 1.5;     // ニクロム線の太さ（半径）
const NICHROME_GLOW = 3.0;          // 電流を流したときの光り方の強さ
const STABI_SEGMENTS = 60;          // 展開中のスタビライザの帯を何区間に分けて曲げるか
const STABI_COIL_CORE_MM = 3;       // 丸まったスタビライザの、いちばん内側の半径
const STABI_COIL_THICKNESS_MM = 1.2; // 丸まったテープ1周ぶんの厚み（見た目用）

// スタビライザ（コンベックステープ）の形を作る定数。寸法そのものは parts.json の stabilizer.tape にある
const STABI_PATH_STEP_MM = 0.5;     // テープの中心線を、何mmごとの点で表すか
const STABI_GEOMETRY_STEP_MM = 2;   // 部品の形（面）を、長さ方向に何mmごとに区切るか
const STABI_WIDTH_DIVISIONS = 8;    // テープの幅方向の区切り（反り＝断面の丸みを出すため）
const STABI_HOLDER_GAP_MM = 0.5;    // ホルダの下面とテープの間のすき間（面が重なってちらつかないように）
const STABI_GROUND_GAP_MM = 0.5;    // 地面とテープ（先端）の間のすき間
const SPIN_PART_IDS = ["tire_left", "tire_right", "shaftholder"];   // 走行で回す部品

// 画面の下に出す操作のヒント（マウス用と、指で触る画面用）
const HINTS_MOUSE = {
  assembly: "ドラッグで回転・ホイールで拡大・右ドラッグで平行移動・← → キーで手順を移動",
  parts: "ドラッグで回転・ホイールで拡大・右ドラッグで平行移動・部品をクリックで説明",
  mission: "ドラッグで回転・ホイールで拡大・右ドラッグで平行移動・← → キーでフェーズを移動",
};
const HINTS_TOUCH = {
  assembly: "1本指で回転・2本指で拡大／移動",
  parts: "1本指で回転・2本指で拡大／移動・部品をタップで説明",
  mission: "1本指で回転・2本指で拡大／移動",
};
// 指で触る画面（スマホ・タブレット）か。
//   pointer: coarse … おもな操作が指（粗い）　any-pointer: fine … マウスやタッチパッドがつながっている
//   タッチ画面付きのノートPCでは、マウスやタッチパッドがあればマウス用の説明を出す
const is_touch_screen = window.matchMedia("(pointer: coarse)").matches
  && !window.matchMedia("(any-pointer: fine)").matches;
const HINTS = is_touch_screen ? HINTS_TOUCH : HINTS_MOUSE;

// 「動きを減らす」設定（OSのアクセシビリティ設定）がオンか
const reduced_motion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const motion_factor = reduced_motion ? REDUCED_MOTION_FACTOR : 1;

// ----- 画面の要素 -----
const $ = (id) => document.getElementById(id);
const viewport_el = $("viewport");
const loading_el = $("loading");
const loading_text_el = $("loading_text");
const loading_bar_el = $("loading_bar");
const loading_errors_el = $("loading_errors");
const hint_el = $("hint");
const tooltip_el = $("tooltip");
// 部品を見るモード
const legend_el = $("legend");
const panel_detail_el = $("panel_detail");
const detail_role_el = $("detail_role");
const detail_material_el = $("detail_material");
const detail_count_el = $("detail_count");
const detail_provisional_el = $("detail_provisional");
const btn_isolate_el = $("btn_isolate");
const explode_slider_el = $("explode_slider");
const translucent_check_el = $("translucent_check");
// 組み立てモード
const step_counter_el = $("step_counter");
const step_title_el = $("step_title");
const step_text_el = $("step_text");
const step_note_el = $("step_note");
const step_specs_el = $("step_specs");
const step_fastening_el = $("step_fastening");
const step_tip_el = $("step_tip");
const step_provisional_el = $("step_provisional");
const step_photos_el = $("step_photos");
const step_list_el = $("step_list");
const step_dots_el = $("step_dots");
const btn_prev_step_el = $("btn_prev_step");
const btn_next_step_el = $("btn_next_step");
const btn_step_view_el = $("btn_step_view");
const lightbox_el = $("lightbox");
const lightbox_img_el = $("lightbox_img");
// ミッションモード
const phase_counter_el = $("phase_counter");
const phase_title_el = $("phase_title");
const phase_text_el = $("phase_text");
const phase_detail_el = $("phase_detail");
const phase_provisional_el = $("phase_provisional");
const phase_list_el = $("phase_list");
const phase_dots_el = $("phase_dots");
const drive_controls_el = $("drive_controls");
const drive_status_el = $("drive_status");
const guidance_status_el = $("guidance_status");
const panel_remote_el = $("panel_remote");
const panel_sequence_el = $("panel_sequence");
const remote_status_el = $("remote_status");
const btn_remote_el = $("btn_remote");
const btn_prev_phase_el = $("btn_prev_phase");
const btn_next_phase_el = $("btn_next_phase");
const btn_autoplay_el = $("btn_autoplay");
const btn_phase_view_el = $("btn_phase_view");

// ----- 画面の状態をひとまとめにする -----
const view_state = {
  mode: "assembly",        // いまのモード："assembly"（組み立て）／"parts"（部品を見る）／"mission"（ミッション）
  parts: [],               // parts.json の中身
  steps: [],               // steps.json の中身
  meshes: [],              // 画面に出している部品（19個）
  // 部品を見るモード
  selected_id: null,       // 選んでいる部品の id（parts.json の id）。選んでいなければ null
  isolate: false,          // 「この部品だけ表示」中か
  translucent: false,      // 「半透明にする」中か
  explode_ratio: 0,        // 分解の量（0＝組み上がった状態、1＝最大）
  // 組み立てモード
  step_index: 0,           // いまの手順（steps.json の何番目か。0から数える）
  follow_camera: true,     // 手順を変えたとき、おすすめの視点へ自動で移るか（自分で回したら false）
  auto_rotate_left_s: 0,   // 「完成」の手順で、一回りし終わるまでの残り時間
};

// ----- 3Dの基本セット -----
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
viewport_el.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xeef2f7);   // 3Dの背景（style.css の --bg と同じ色）

const camera = new THREE.PerspectiveCamera(CAMERA_FOV_DEG, 1, 1, 10000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;   // 手を離したあと少しすべるように止まる
controls.minDistance = MIN_CAMERA_DISTANCE_MM;   // スマホの2本指で寄りすぎても、注視点の手前で止まる（#24）

// CAD座標（z が上）の部品をすべてこの中に入れる。回転はここに1回だけかける
const model_root = new THREE.Group();
model_root.rotation.x = -Math.PI / 2;
scene.add(model_root);

// 部品をまとめた機体グループ（ミッションモードで、これごと動かす。ほかのモードでは原点のまま）
const vehicle = new THREE.Group();
model_root.add(vehicle);

// 完成状態の機体全体を囲む箱（視点の計算に使う）
let model_box = new THREE.Box3();

// CADの座標 [x, y, z]（z が上）を、Three.js の座標（y が上）に直す。
// 親グループの「x軸まわりに −90°」と同じ対応：(x, y, z) → (x, z, −y)
function cad_to_three(cad) {
  return new THREE.Vector3(cad[0], cad[2], -cad[1]);
}

// =============================================================
// 読み込み
// =============================================================

// ---------------------------------------------------------------
// JSONを読む。失敗したら、どのファイルが読めなかったかを分かるようにする
// ---------------------------------------------------------------
// ---------------------------------------------------------------
// 読み込みに失敗したら、少し待ってやり直す。
// py -m http.server は同時に受け付けられる接続が少ない（待ち行列が5つ）ので、
// たくさんのファイルを一度に読むと、まれに接続を断られることがあるため
// ---------------------------------------------------------------
const LOAD_ATTEMPTS = 3;          // 何回まで試すか
const RETRY_WAIT_MS = 400;        // やり直す前に待つ時間（回数ごとに長くする）

async function with_retry(load) {
  let last_error;
  for (let attempt = 1; attempt <= LOAD_ATTEMPTS; attempt++) {
    try {
      return await load();
    } catch (err) {
      last_error = err;
      if (err.no_retry) break;   // ファイルの中身の誤りなど、やり直しても直らないもの
      if (attempt < LOAD_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, RETRY_WAIT_MS * attempt));
    }
  }
  throw last_error;
}

async function load_json(url) {
  return with_retry(() => load_json_once(url));
}

async function load_json_once(url) {
  // JSONを直したらすぐ画面に反映されるように、ブラウザの一時保存（キャッシュ）を使わない
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) {
    const error = new Error(`${url} を読み込めませんでした（HTTP ${response.status}。ファイル名・置き場所を確認してください）`);
    error.no_retry = response.status === 404;   // ファイルがないときは、やり直しても同じ
    throw error;
  }
  try {
    return await response.json();
  } catch (err) {
    const error = new Error(`${url} の書き方（JSONの文法）に誤りがあります：${err.message}`);
    error.no_retry = true;
    throw error;
  }
}

// ---------------------------------------------------------------
// 読み込み中の表示を更新する
// ---------------------------------------------------------------
function show_progress(done_count, total_count) {
  loading_text_el.textContent = `部品を読み込み中… ${done_count} / ${total_count}`;
  loading_bar_el.style.width = `${(100 * done_count) / total_count}%`;
}

function show_error(message) {
  const item = document.createElement("li");
  item.textContent = message;
  loading_errors_el.appendChild(item);
  console.error(message);
}

// ---------------------------------------------------------------
// 1つのSTLの中で色を分けたいとき（タイヤ＋モータ）に使う。
// 三角形の重心が、指定した軸で「below」より小さいものを2つ目の色にする。
// 三角形の順番を並べ替えて、色ごとにまとまり（group）を作る。
// ---------------------------------------------------------------
const AXIS_INDEX = { x: 0, y: 1, z: 2 };
const VERTICES_PER_TRIANGLE = 3;
const FLOATS_PER_VERTEX = 3;

function split_geometry_by_axis(geometry, split) {
  const axis = AXIS_INDEX[split.axis];
  const positions = geometry.getAttribute("position").array;
  const normals = geometry.getAttribute("normal").array;
  const floats_per_triangle = VERTICES_PER_TRIANGLE * FLOATS_PER_VERTEX;
  const triangle_count = positions.length / floats_per_triangle;

  // 三角形ごとに「主の色」か「2つ目の色」かを決める
  const main_triangles = [];
  const sub_triangles = [];
  for (let t = 0; t < triangle_count; t++) {
    const base = t * floats_per_triangle;
    const centroid =
      (positions[base + axis] + positions[base + 3 + axis] + positions[base + 6 + axis]) / 3;
    (centroid < split.below ? sub_triangles : main_triangles).push(t);
  }

  // 主の色 → 2つ目の色 の順に詰め直す
  const new_positions = new Float32Array(positions.length);
  const new_normals = new Float32Array(normals.length);
  let write_index = 0;
  for (const t of [...main_triangles, ...sub_triangles]) {
    const base = t * floats_per_triangle;
    new_positions.set(positions.subarray(base, base + floats_per_triangle), write_index);
    new_normals.set(normals.subarray(base, base + floats_per_triangle), write_index);
    write_index += floats_per_triangle;
  }

  const result = new THREE.BufferGeometry();
  result.setAttribute("position", new THREE.BufferAttribute(new_positions, 3));
  result.setAttribute("normal", new THREE.BufferAttribute(new_normals, 3));
  const main_vertex_count = main_triangles.length * VERTICES_PER_TRIANGLE;
  const sub_vertex_count = sub_triangles.length * VERTICES_PER_TRIANGLE;
  result.addGroup(0, main_vertex_count, 0);                    // 材質0：主の色
  result.addGroup(main_vertex_count, sub_vertex_count, 1);     // 材質1：2つ目の色
  return result;
}

// ---------------------------------------------------------------
// 部品の材質（色）を作る。STLには色がないので parts.json の色を使う
// ---------------------------------------------------------------
function make_material(color) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.65,
    metalness: 0.05,
    side: THREE.DoubleSide,   // STLの面の向きが乱れていても裏から見えなくならないように
  });
}

// ---------------------------------------------------------------
// placements.json の rotation（3×3）と translation から 4×4 の行列を作る
//   q = rotation × p + translation
// ---------------------------------------------------------------
function make_placement_matrix(placement) {
  const r = placement.rotation;
  const t = placement.translation;
  return new THREE.Matrix4().set(
    r[0][0], r[0][1], r[0][2], t[0],
    r[1][0], r[1][1], r[1][2], t[1],
    r[2][0], r[2][1], r[2][2], t[2],
    0, 0, 0, 1,
  );
}

// ---------------------------------------------------------------
// 全STLを読み込み、部品を配置する
// ---------------------------------------------------------------
async function load_and_place_parts(parts, placements) {
  const loader = new STLLoader();
  const geometry_by_file = new Map();

  // 読み込むSTL（種類ごとに1回）
  const files = [...new Set(placements.map((p) => p.file))];
  let done_count = 0;
  show_progress(done_count, files.length);

  await Promise.all(
    files.map(async (file) => {
      try {
        const url = MODELS_DIR + encodeURIComponent(file) + VERSION_QUERY;
        let geometry = await with_retry(() => loader.loadAsync(url));
        const part = parts.find((p) => p.file === file);
        if (part && part.split) {
          geometry = split_geometry_by_axis(geometry, part.split);
        }
        geometry.computeBoundingBox();
        geometry_by_file.set(file, geometry);
      } catch (err) {
        show_error(`models/${file} を読み込めませんでした（ファイル名・置き場所を確認してください）`);
      }
      done_count += 1;
      show_progress(done_count, files.length);
    }),
  );

  // 配置データ1つにつき1つの Mesh を作る（同じSTLはジオメトリを共有）
  const meshes = [];
  for (const placement of placements) {
    const geometry = geometry_by_file.get(placement.file);
    if (!geometry) continue;   // 読み込み失敗した部品は飛ばす（エラーは表示済み）

    const part = parts.find((p) => p.file === placement.file);
    if (!part) {
      show_error(`parts.json に ${placement.file} の部品がありません（placements.json の "${placement.name}"）`);
      continue;
    }

    const material = part.split
      ? [make_material(part.color), make_material(part.split.color)]
      : make_material(part.color);
    meshes.push(make_part_mesh(placement.name, part, geometry, material, make_placement_matrix(placement)));
  }
  return meshes;
}

// ---------------------------------------------------------------
// 部品の Mesh を作って機体グループに入れる（STLの部品も、プログラムで作る部品も同じ形にそろえる）
// ---------------------------------------------------------------
function make_part_mesh(name, part, geometry, material, base_matrix) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.userData.part_id = part.id;
  mesh.matrixAutoUpdate = false;               // 行列を直接与えるので自動計算を止める
  mesh.userData.base_matrix = base_matrix;     // 組み上がった位置
  mesh.userData.offset = new THREE.Vector3();  // 組み上がった位置からのずれ（CAD座標のmm）
  mesh.userData.spin = 0;                      // 車軸まわりの回転角（走行でタイヤを回すときに使う）
  // 組み上がった状態での部品の中心（CAD座標）
  mesh.userData.center = geometry.boundingBox.clone()
    .applyMatrix4(base_matrix)
    .getCenter(new THREE.Vector3());
  mesh.matrix.copy(base_matrix);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  vehicle.add(mesh);
  return mesh;
}

// =============================================================
// スタビライザ（コンベックステープ）：STLがないので、寸法からプログラムで形を作る
// =============================================================
let stabilizer_shape = null;   // 作った形（中心線）。ミッションモードの展開・転倒でも使う
const BISECTION_STEPS = 40;    // 二分法（範囲を半分ずつ狭めて答えを探す方法）をくり返す回数

// ---------------------------------------------------------------
// テープの中心線（テープの真ん中を通る線）を作る。横から見た y-z 面の中の線で、
//   ① ホルダの下に押さえつけられた部分（水平）→ ② 下へ曲がる → ③ 斜め下へまっすぐ
//   → ④ 水平へ戻る → ⑤ 地面に平らに着く先端（足）
// の順につながる。theta は進む向き（後ろ向き＝+y から測った角度。下向きがマイナス）
// ---------------------------------------------------------------
function make_stabilizer_path(tape, holder_box) {
  const x = (holder_box.min.x + holder_box.max.x) / 2;
  const start_y = holder_box.min.y;                          // ホルダの前の端（ここからテープが押さえられている）
  const start_z = holder_box.min.z - STABI_HOLDER_GAP_MM;    // ホルダの下面
  const ground_z = GROUND_Z_MM + STABI_GROUND_GAP_MM;
  const clamp_length = holder_box.max.y - start_y;           // ホルダに押さえられている長さ
  const radius = tape.bend_radius_mm;
  const foot = tape.foot_length_mm;
  const drop = start_z - ground_z;                           // 下がる高さ

  // 斜めの部分の角度 slope を探す：下がる高さ ＝ 曲がり2か所ぶん ＋ まっすぐな部分ぶん
  //   tape.length_mm は「ホルダから出たところから先端まで」の長さ
  const drop_at = (slope) => {
    const straight = tape.length_mm - foot - 2 * radius * slope;
    return 2 * radius * (1 - Math.cos(slope)) + straight * Math.sin(slope);
  };
  if (drop_at(Math.PI / 2) < drop) {
    show_error("スタビライザが短すぎて、先端が地面に届きません（parts.json の stabilizer の tape を確認してください）");
  }
  let low = 0;
  let high = Math.PI / 2;
  for (let i = 0; i < BISECTION_STEPS; i++) {
    const middle = (low + high) / 2;
    if (drop_at(middle) < drop) low = middle; else high = middle;
  }
  const slope = high;
  const bend_length = radius * slope;
  const straight = tape.length_mm - foot - 2 * bend_length;

  // 区間の境目（中心線の始まりから測った長さ）
  const s_exit = clamp_length;                // ホルダから出る
  const s_bent = s_exit + bend_length;        // 下へ曲がり終わる
  const s_straight = s_bent + straight;       // まっすぐな部分の終わり
  const s_foot = s_straight + bend_length;    // 水平に戻り終わる（ここから足）
  const total = s_foot + foot;
  const theta_at = (s) => {
    if (s <= s_exit) return 0;
    if (s <= s_bent) return -(s - s_exit) / radius;
    if (s <= s_straight) return -slope;
    if (s <= s_foot) return -slope + (s - s_straight) / radius;
    return 0;
  };

  // 進む向きを少しずつ足し合わせて（積分して）、点の位置を求める
  const count = Math.ceil(total / STABI_PATH_STEP_MM);
  const ds = total / count;
  const position = new THREE.Vector3(x, start_y, start_z);
  const points = [{ position: position.clone(), theta: 0 }];
  for (let i = 1; i <= count; i++) {
    const middle_theta = theta_at((i - 0.5) * ds);   // 区間の真ん中の向きを使うと誤差が小さい
    position.y += Math.cos(middle_theta) * ds;
    position.z += Math.sin(middle_theta) * ds;
    points.push({ position: position.clone(), theta: theta_at(i * ds) });
  }
  return { points, total, clamp_length, foot_start: s_foot, slope_rad: slope };
}

// 中心線の上で、始まりから長さ s の点（点と点の間は直線でつなぐ）
function stabilizer_point_at(s) {
  const points = stabilizer_shape.points;
  const f = (THREE.MathUtils.clamp(s, 0, stabilizer_shape.total) / stabilizer_shape.total) * (points.length - 1);
  const i = Math.min(Math.floor(f), points.length - 2);
  const t = f - i;
  return {
    position: points[i].position.clone().lerp(points[i + 1].position, t),
    theta: THREE.MathUtils.lerp(points[i].theta, points[i + 1].theta, t),
  };
}

// ---------------------------------------------------------------
// テープの面を作る。幅方向には反り（コンベックステープの断面の丸み）を付ける。
// ホルダの下と先端の足は、押さえて平らにしてあるので反りなし。
// 材料は2つ：0 ＝ テープ（白）、1 ＝ 先端の足（黒）
// ---------------------------------------------------------------
const STABI_CROWN_BLEND_MM = 10;   // 反りが付く・消えるまでの長さ

function make_stabilizer_geometry(tape) {
  const shape = stabilizer_shape;
  const half_width = tape.width_mm / 2;
  const rows = Math.ceil(shape.total / STABI_GEOMETRY_STEP_MM);
  const cols = STABI_WIDTH_DIVISIONS;
  const positions = [];
  for (let r = 0; r <= rows; r++) {
    const s = (shape.total * r) / rows;
    const { position, theta } = stabilizer_point_at(s);
    const crown = tape.crown_mm * Math.min(
      THREE.MathUtils.smoothstep(s, shape.clamp_length, shape.clamp_length + STABI_CROWN_BLEND_MM),
      1 - THREE.MathUtils.smoothstep(s, shape.foot_start - STABI_CROWN_BLEND_MM, shape.foot_start),
    );
    // テープの面に垂直で、上側を向く向き（進む向きを90°起こした向き）
    const normal_y = -Math.sin(theta);
    const normal_z = Math.cos(theta);
    for (let c = 0; c <= cols; c++) {
      const u = -1 + (2 * c) / cols;      // 幅方向の位置（-1 ＝ 右の端、1 ＝ 左の端）
      const lift = crown * (1 - u * u);   // 真ん中が盛り上がる（放物線で近似）
      positions.push(position.x + u * half_width, position.y + normal_y * lift, position.z + normal_z * lift);
    }
  }
  // 四角形を2つの三角形に分けて面を張る。足の部分は別の材料（黒）にする
  const tape_indices = [];
  const foot_indices = [];
  for (let r = 0; r < rows; r++) {
    const s_middle = (shape.total * (r + 0.5)) / rows;
    const list = s_middle >= shape.foot_start ? foot_indices : tape_indices;
    for (let c = 0; c < cols; c++) {
      const a = r * (cols + 1) + c;   // この区切りの点
      const b = a + cols + 1;         // 次の区切りの、同じ幅位置の点
      list.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex([...tape_indices, ...foot_indices]);
  geometry.addGroup(0, tape_indices.length, 0);
  geometry.addGroup(tape_indices.length, foot_indices.length, 1);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}

// ---------------------------------------------------------------
// STLのない部品（parts.json に "shape" がある部品）を、プログラムで作って置く
// ---------------------------------------------------------------
function add_generated_parts(parts, meshes) {
  const added = [];
  for (const part of parts.filter((p) => p.shape)) {
    if (part.shape !== "stabilizer") {
      show_error(`parts.json の "${part.id}" の shape "${part.shape}" は作り方が分かりません`);
      continue;
    }
    const holder = meshes.find((mesh) => mesh.userData.part_id === part.tape.holder);
    if (!holder) {
      show_error(`スタビライザを留めるホルダ "${part.tape.holder}" が読み込めていないので、スタビライザを作れません`);
      continue;
    }
    // ホルダが組み上がった位置での、ホルダを囲む箱（CAD座標）
    const holder_box = holder.geometry.boundingBox.clone().applyMatrix4(holder.userData.base_matrix);
    stabilizer_shape = make_stabilizer_path(part.tape, holder_box);
    const geometry = make_stabilizer_geometry(part.tape);
    const material = [make_material(part.color), make_material(part.foot_color)];
    // 形はCAD座標で作ってあるので、置く位置はそのまま（単位行列）
    added.push(make_part_mesh("Stabilizer", part, geometry, material, new THREE.Matrix4()));
  }
  return added;
}

// =============================================================
// 地面・光・視点
// =============================================================

// ---------------------------------------------------------------
// 文字を板に貼った目印（「前」「後ろ」）を作る
// ---------------------------------------------------------------
const LABEL_CANVAS_SIZE = 256;
const LABEL_SIZE_MM = 40;

function make_ground_label(text) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = LABEL_CANVAS_SIZE;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#5d6675";
  ctx.font = `bold ${LABEL_CANVAS_SIZE * 0.45}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, LABEL_CANVAS_SIZE / 2, LABEL_CANVAS_SIZE / 2);
  const texture = new THREE.CanvasTexture(canvas);
  const label = new THREE.Mesh(
    new THREE.PlaneGeometry(LABEL_SIZE_MM, LABEL_SIZE_MM),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }),
  );
  label.rotation.x = -Math.PI / 2;   // 地面に寝かせる
  return label;
}

// 前を示す矢印（地面に置く三角形）
function make_front_arrow() {
  const shape = new THREE.Shape();
  shape.moveTo(0, 18);
  shape.lineTo(-12, 0);
  shape.lineTo(12, 0);
  shape.closePath();
  const arrow = new THREE.Mesh(
    new THREE.ShapeGeometry(shape),
    new THREE.MeshBasicMaterial({ color: 0x2f6fd6, side: THREE.DoubleSide }),
  );
  arrow.rotation.x = -Math.PI / 2;   // 地面に寝かせると、+y が Three.js の −z を向く
  arrow.rotation.z = Math.PI;        // 向きを反転して +z（＝機体の前）を指すようにする
  return arrow;
}

// ---------------------------------------------------------------
// 地面・影・光・前後の目印を作る
// ---------------------------------------------------------------
// 影を作る光（ミッションモードで機体を追いかけるので、外から触れるようにしておく）
const sun = new THREE.DirectionalLight(0xffffff, 2.2);

function setup_environment() {
  const ground_y = GROUND_Z_MM;   // CADの z → Three.js の y（親グループの回転と同じ対応）
  const LIFT_MM = 0.2;            // 地面と目印が重なってちらつかないように少し浮かす

  // 光：全体を照らす光（空と地面の色）＋影を作る光1つ
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8d8d8d, 1.6));
  sun.position.copy(SUN_OFFSET);
  sun.castShadow = true;
  sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  const shadow_range = 250;
  Object.assign(sun.shadow.camera, {
    left: -shadow_range, right: shadow_range, top: shadow_range, bottom: -shadow_range,
    near: 50, far: 1200,
  });
  sun.shadow.bias = -0.0005;
  scene.add(sun);
  scene.add(sun.target);   // 光が向く点。ミッションモードで機体を追いかけるため、シーンに入れて動かせるようにする

  // 影を受ける地面（影だけが見える透明な板）
  const shadow_plane = new THREE.Mesh(
    new THREE.PlaneGeometry(GROUND_SIZE_MM, GROUND_SIZE_MM),
    new THREE.ShadowMaterial({ opacity: 0.25 }),
  );
  shadow_plane.rotation.x = -Math.PI / 2;
  shadow_plane.position.y = ground_y;
  shadow_plane.receiveShadow = true;
  scene.add(shadow_plane);

  // うすい格子
  const grid = new THREE.GridHelper(GROUND_SIZE_MM, GROUND_DIVISIONS, 0xb8bec8, 0xd3d8df);
  grid.position.y = ground_y + LIFT_MM;
  scene.add(grid);

  // 前後の目印（CADの −y が前 → Three.js の +z が前）
  const front_label = make_ground_label("前");
  front_label.position.set(0, ground_y + LIFT_MM * 2, MARKER_DISTANCE_MM + 30);
  scene.add(front_label);

  const front_arrow = make_front_arrow();
  front_arrow.position.set(0, ground_y + LIFT_MM * 2, MARKER_DISTANCE_MM - 10);
  scene.add(front_arrow);

  const back_label = make_ground_label("後ろ");
  back_label.position.set(0, ground_y + LIFT_MM * 2, -MARKER_DISTANCE_MM - 30);
  scene.add(back_label);
}

// ---------------------------------------------------------------
// 部品を見るモードの視点に戻す（機体全体が画面に収まる距離を計算する）
// ---------------------------------------------------------------
// 縦長の画面で、カメラを何倍引くか（横長の画面では 1）
function narrow_view_scale() {
  return THREE.MathUtils.clamp(REFERENCE_ASPECT / camera.aspect, 1, MAX_NARROW_VIEW_SCALE);
}

function reset_view() {
  stop_camera_motion();
  const center = model_box.getCenter(new THREE.Vector3());
  const radius = model_box.getBoundingSphere(new THREE.Sphere()).radius;
  const distance = (radius * CAMERA_FIT_MARGIN * narrow_view_scale())
    / Math.sin(THREE.MathUtils.degToRad(CAMERA_FOV_DEG / 2));
  camera.position.copy(center).addScaledVector(DEFAULT_VIEW_DIRECTION, distance);
  controls.target.copy(center);
  controls.update();
}

// =============================================================
// なめらかな動き（アニメーション）のしくみ
//   start_tween("名前", 時間, 進み具合を受け取る関数) で始め、描画のたびに進める。
//   同じ名前で始め直すと、前の動きは打ち切られる（手順を素早く切り替えても崩れない）
// =============================================================
const tweens = new Map();

// 始めはゆっくり・途中は速く・最後はゆっくり（視点の移動用）
function ease_in_out_cubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
// 速く動き出して、最後にゆっくり止まる（部品が収まる動き用）
function ease_out_cubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function start_tween(name, duration_s, on_update, easing = ease_in_out_cubic, on_done = null) {
  tweens.set(name, { elapsed: 0, duration: Math.max(duration_s, 0.001), on_update, easing, on_done });
  on_update(0);
}

function cancel_tween(name) {
  tweens.delete(name);
}

function update_tweens(dt) {
  for (const [name, tween] of tweens) {
    tween.elapsed += dt;
    const progress = Math.min(tween.elapsed / tween.duration, 1);
    tween.on_update(tween.easing(progress));
    if (progress >= 1) {
      tweens.delete(name);
      if (tween.on_done) tween.on_done();
    }
  }
}

// ---------------------------------------------------------------
// 視点を、指定した位置・注視点へなめらかに動かす（座標はCAD座標で受け取る）
// ---------------------------------------------------------------
function move_camera_to(camera_spec, on_done = null) {
  const from_position = camera.position.clone();
  const from_target = controls.target.clone();
  const to_target = cad_to_three(camera_spec.target);
  // 注視点からカメラまでの距離を、縦長の画面では長くする
  const to_position = cad_to_three(camera_spec.position).sub(to_target)
    .multiplyScalar(narrow_view_scale()).add(to_target);

  start_tween(
    "camera",
    CAMERA_MOVE_DURATION_S * motion_factor,
    (t) => {
      camera.position.lerpVectors(from_position, to_position, t);
      controls.target.lerpVectors(from_target, to_target, t);
    },
    ease_in_out_cubic,
    on_done,
  );
}

// 「完成」の手順で機体を一回りさせる（OrbitControls の自動回転を使う）
function start_auto_rotate() {
  controls.autoRotate = true;
  controls.autoRotateSpeed = SECONDS_PER_MINUTE / AUTO_ROTATE_DURATION_S;   // 8秒で1周
  view_state.auto_rotate_left_s = AUTO_ROTATE_DURATION_S;
}

function update_auto_rotate(dt) {
  if (!controls.autoRotate) return;
  view_state.auto_rotate_left_s -= dt;
  if (view_state.auto_rotate_left_s <= 0) controls.autoRotate = false;   // 一回りしたら止める
}

// 視点の自動の動き（移動・自動回転）をすべて止める
function stop_camera_motion() {
  cancel_tween("camera");
  controls.autoRotate = false;
}

// =============================================================
// 部品の位置と見た目（全モード共通）
// =============================================================

// ---------------------------------------------------------------
// 部品の id から parts.json の項目を探す
// ---------------------------------------------------------------
function find_part(part_id) {
  return view_state.parts.find((p) => p.id === part_id);
}

// ---------------------------------------------------------------
// 部品を、組み上がった位置から offset（CAD座標のmm）だけずらして置く
// ---------------------------------------------------------------
function set_mesh_offset(mesh, offset) {
  mesh.userData.offset.copy(offset);
  compose_mesh_matrix(mesh);
}

// 部品を、自分の車軸（x軸に平行で、部品の中心を通る線）のまわりに回す（タイヤ用）
function set_mesh_spin(mesh, angle) {
  mesh.userData.spin = angle;
  compose_mesh_matrix(mesh);
}

// ---------------------------------------------------------------
// 部品の行列を組み立てる
//   行列 = ずらす × （車軸の位置へ移す × 回す × 原点へ戻す）× 組み上がった位置
//   右から順に効く：まず組み上がった位置に置き、車軸まわりに回し、最後にずらす
// ---------------------------------------------------------------
const shift_matrix = new THREE.Matrix4();
const spin_matrix = new THREE.Matrix4();
const pivot_matrix = new THREE.Matrix4();

function compose_mesh_matrix(mesh) {
  const { offset, spin, center, base_matrix } = mesh.userData;
  mesh.matrix.makeTranslation(offset.x, offset.y, offset.z);
  if (spin !== 0) {
    pivot_matrix.makeTranslation(0, center.y, center.z);
    mesh.matrix.multiply(pivot_matrix);
    mesh.matrix.multiply(spin_matrix.makeRotationX(spin));
    mesh.matrix.multiply(pivot_matrix.makeTranslation(0, -center.y, -center.z));
  }
  mesh.matrix.multiply(base_matrix);
}

// ---------------------------------------------------------------
// 1つの部品の見た目を決める
//   visible：表示するか／highlight：光らせるか／translucent：半透明にするか
// ---------------------------------------------------------------
function set_mesh_look(mesh, { visible, highlight, translucent }) {
  mesh.visible = visible;
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const material of materials) {
    material.emissive.set(highlight ? HIGHLIGHT_COLOR : 0x000000);
    material.emissiveIntensity = highlight ? HIGHLIGHT_INTENSITY : 0;
    if (material.transparent !== translucent) {
      material.transparent = translucent;
      material.opacity = translucent ? TRANSLUCENT_OPACITY : 1;
      material.depthWrite = !translucent;   // 奥の部品が透けて見えるようにする
      material.needsUpdate = true;
    }
  }
  mesh.castShadow = !translucent;
}

// ---------------------------------------------------------------
// いまのモードと状態に合わせて、全部品の見た目を決め直す
// ---------------------------------------------------------------
function apply_appearance() {
  for (const mesh of view_state.meshes) {
    if (view_state.mode === "assembly") {
      // 組み立て：いまの手順までの部品を表示し、いまの手順で加えた部品を光らせる
      const added_at = mesh.userData.step_index;
      set_mesh_look(mesh, {
        visible: added_at <= view_state.step_index,
        highlight: added_at === view_state.step_index,
        translucent: false,
      });
    } else if (view_state.mode === "mission") {
      // ミッション：全部品を普通に表示する
      set_mesh_look(mesh, { visible: true, highlight: false, translucent: false });
    } else {
      // 部品を見る：選んだ部品を光らせる。単独表示・半透明は選んだ部品以外にかける
      const is_selected = mesh.userData.part_id === view_state.selected_id;
      set_mesh_look(mesh, {
        visible: !view_state.isolate || is_selected,
        highlight: is_selected,
        translucent: view_state.translucent && !is_selected,
      });
    }
  }
}

// =============================================================
// モードの切り替え
// =============================================================
const MODES = ["assembly", "parts", "mission"];

function set_mode(mode) {
  const previous_mode = view_state.mode;
  view_state.mode = mode;
  stop_camera_motion();
  cancel_tween("fly");
  hide_tooltip();

  // ミッションモードを出るときは、機体を原点に戻し、仮の形を隠す
  if (mode !== "mission") leave_mission();

  document.querySelectorAll(".mode[data-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });
  for (const name of MODES) {
    $(`panel_${name}`).classList.toggle("hidden", mode !== name);
    $(`bar_${name}`).classList.toggle("hidden", mode !== name);
  }
  hint_el.textContent = HINTS[mode];

  if (mode === "assembly") {
    view_state.follow_camera = true;   // モードに入ったときは、おすすめの視点から始める
    go_to_step(view_state.step_index);
  } else if (mode === "mission") {
    enter_mission();
  } else {
    update_explode_positions();
    render_parts_panel();
    apply_appearance();
    // ミッションで機体が上空や遠くにいたときは、視点を機体の近くに戻す
    if (previous_mode === "mission") reset_view();
  }
  update_location_hash();   // URL も、このモードに合わせる（#16）
}

// =============================================================
// 組み立てモード
// =============================================================

// ---------------------------------------------------------------
// steps.json を確かめ、各部品が「何番目の手順で加わるか」を記録する
// ---------------------------------------------------------------
function assign_steps_to_meshes(steps, meshes) {
  const NOT_IN_STEPS = Infinity;   // どの手順にも入っていない部品（表示されない）
  for (const mesh of meshes) mesh.userData.step_index = NOT_IN_STEPS;

  steps.forEach((step, index) => {
    for (const part_id of step.add) {
      if (!find_part(part_id)) {
        show_error(`steps.json の手順 ${step.id} にある部品 "${part_id}" が parts.json にありません`);
        continue;
      }
      for (const mesh of meshes) {
        if (mesh.userData.part_id === part_id) mesh.userData.step_index = index;
      }
    }
  });

  const missing = meshes.filter((m) => m.userData.step_index === NOT_IN_STEPS).map((m) => m.name);
  if (missing.length > 0) {
    show_error(`steps.json のどの手順にも入っていない部品があります：${missing.join("、")}`);
  }
}

// ---------------------------------------------------------------
// 部品が飛んでくる前の位置（完成位置からのずれ）を求める
//   steps.json の directions（部品ごと）→ direction（手順全体）の順に向きを探す。
//   "outward_x" は「その部品がある側の外側から」（左右のタイヤなど）という意味
// ---------------------------------------------------------------
function get_fly_offset(mesh, step) {
  const spec = (step.directions && step.directions[mesh.userData.part_id]) ?? step.direction ?? [0, 0, 1];
  let direction;
  if (spec === "outward_x") {
    direction = new THREE.Vector3(Math.sign(mesh.userData.center.x) || 1, 0, 0);
  } else if (Array.isArray(spec)) {
    direction = new THREE.Vector3(...spec).normalize();
  } else {
    show_error(`steps.json の手順 ${step.id} の取り付け方向 "${spec}" が読めません（[x, y, z] か "outward_x" で書く）`);
    direction = new THREE.Vector3(0, 0, 1);
  }
  return direction.multiplyScalar(step.distance ?? FLY_DISTANCE_MM);
}

// ---------------------------------------------------------------
// 指定した手順を表示する
//   1. 全部品を完成位置に戻し、表示・非表示・光らせ方を決める
//   2. この手順で加える部品だけを、離れた位置から完成位置へ動かす
//   どの手順からどの手順へ移っても、毎回ここで全部品の状態を決め直すので、
//   前後に何度行き来しても表示が崩れない
// ---------------------------------------------------------------
function go_to_step(index) {
  const steps = view_state.steps;
  if (steps.length === 0) return;
  index = THREE.MathUtils.clamp(index, 0, steps.length - 1);
  view_state.step_index = index;
  const step = steps[index];

  // 1. 全部品を完成位置へ
  cancel_tween("fly");
  const zero = new THREE.Vector3();
  for (const mesh of view_state.meshes) set_mesh_offset(mesh, zero);
  apply_appearance();

  // 2. この手順の部品を飛ばす（速く動き出して、最後にゆっくり収まる）
  const flying = view_state.meshes.filter((m) => m.userData.step_index === index);
  if (flying.length > 0) {
    const start_offsets = flying.map((mesh) => get_fly_offset(mesh, step));
    const current = new THREE.Vector3();
    start_tween(
      "fly",
      FLY_DURATION_S * motion_factor,
      (t) => {
        flying.forEach((mesh, i) => set_mesh_offset(mesh, current.copy(start_offsets[i]).multiplyScalar(1 - t)));
      },
      ease_out_cubic,
    );
  }

  // 視点：自分で回していなければ、おすすめの視点へ移る
  stop_camera_motion();
  const rotate_after = step.auto_rotate && !reduced_motion;
  if (view_state.follow_camera && step.camera) {
    move_camera_to(step.camera, rotate_after ? start_auto_rotate : null);
  } else if (rotate_after) {
    start_auto_rotate();
  }

  render_step_panel();
  update_location_hash();   // URL も、この手順に合わせる（#16）
}

// ---------------------------------------------------------------
// 右の欄に、いまの手順の説明を出す
// ---------------------------------------------------------------
function render_step_panel() {
  const steps = view_state.steps;
  const index = view_state.step_index;
  const step = steps[index];

  step_counter_el.textContent = `手順 ${step.id}（${index + 1} / ${steps.length}）`;
  step_title_el.textContent = step.title;
  step_text_el.textContent = step.text;

  set_optional_text(step_note_el, step.note);
  set_optional_text(step_tip_el, step.tip);
  set_optional_text(step_provisional_el, step.provisional ? `仮：${step.provisional}` : "");
  step_specs_el.classList.toggle("hidden", !step.fastening);
  step_fastening_el.textContent = step.fastening ?? "";

  render_step_photos(step);
  render_step_list();
  render_step_dots();
  render_step_buttons();
  panel_detail_el.closest(".panel").scrollTop = 0;
}

// 文が空のときは、その欄ごと隠す
function set_optional_text(element, text) {
  element.classList.toggle("hidden", !text);
  element.textContent = text ?? "";
}

// 手順の写真（小さく並べ、クリックで大きく見る）
function render_step_photos(step) {
  step_photos_el.innerHTML = "";
  const photos = step.photos ?? [];
  if (photos.length === 0) {
    const none = document.createElement("p");
    none.className = "no_photo";
    none.textContent = "この手順の写真はありません";
    step_photos_el.appendChild(none);
    return;
  }
  for (const photo of photos) {
    const button = document.createElement("button");
    button.title = "クリックで大きく見る";
    const img = document.createElement("img");
    img.src = PHOTOS_DIR + encodeURIComponent(photo);
    img.alt = `手順 ${step.id} の写真（${photo}）`;
    img.addEventListener("error", () => show_photo_error(button, photo));
    button.appendChild(img);
    button.addEventListener("click", () => open_lightbox(img.src, img.alt));
    step_photos_el.appendChild(button);
  }
}

function show_photo_error(button, photo) {
  const message = document.createElement("p");
  message.className = "no_photo";
  message.textContent = `写真 photos/${photo} を読み込めませんでした`;
  button.replaceWith(message);
  console.error(message.textContent);
}

// 手順の一覧（クリックでその手順へ飛ぶ）
function render_step_list() {
  step_list_el.innerHTML = "";
  view_state.steps.forEach((step, index) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.textContent = `${step.id}．${step.title}`;
    if (index === view_state.step_index) button.setAttribute("aria-current", "step");
    button.addEventListener("click", () => go_to_step(index));
    item.appendChild(button);
    step_list_el.appendChild(item);
  });
}

// 下の帯の「●●●○○」（済んだ手順・いまの手順・まだの手順）
function render_step_dots() {
  step_dots_el.innerHTML = "";
  view_state.steps.forEach((step, index) => {
    const dot = document.createElement("button");
    dot.title = `手順 ${step.id}：${step.title}`;
    dot.setAttribute("aria-label", dot.title);
    if (index < view_state.step_index) dot.classList.add("done");
    if (index === view_state.step_index) dot.setAttribute("aria-current", "step");
    dot.addEventListener("click", () => go_to_step(index));
    step_dots_el.appendChild(dot);
  });
}

function render_step_buttons() {
  btn_prev_step_el.disabled = view_state.step_index === 0;
  btn_next_step_el.disabled = view_state.step_index === view_state.steps.length - 1;
  // 自分で視点を動かしたあとは、「おすすめの視点に戻す」を目立たせる
  btn_step_view_el.classList.toggle("attention", !view_state.follow_camera);
}

// ---------------------------------------------------------------
// 写真の拡大表示
// ---------------------------------------------------------------
function open_lightbox(src, alt) {
  lightbox_img_el.src = src;
  lightbox_img_el.alt = alt;
  lightbox_el.classList.remove("hidden");
}

function close_lightbox() {
  lightbox_el.classList.add("hidden");
}

// =============================================================
// ミッションモード
//
// 考え方：フェーズの番号と、そのフェーズの進み具合 t（0〜1）を決めれば、
// 機体の位置・パラシュートの開き具合などがすべて1通りに決まるように作る
// （mission_pose 関数）。こうしておくと、どのフェーズへ飛んでも表示が崩れない。
// 走行フェーズだけは、ボタンの操作で動くので、別に状態（mission.drive）を持つ。
// =============================================================
const mission = {
  data: null,              // mission.json の中身
  phase_index: 0,          // いまのフェーズ（0から数える）
  time_s: 0,               // いまのフェーズが始まってからの時間
  hold_s: 0,               // フェーズが終わってから、次へ進むまで待った時間（自動再生用）
  playing: false,          // 自動再生中か
  follow_camera: true,     // フェーズを変えたとき、おすすめの視点へ自動で移るか
  remote: false,           // 遠隔操作（ボタンで走らせる）の画面になっているか。ミッションの流れとは別
  remote_last_distance: Infinity,   // 遠隔操作で、前のコマでのゴールまでの距離（近づいているかを調べる）
  props: null,             // 仮の形（キャリア・エンベロープ・パラシュートなど）
  vehicle_world: new THREE.Vector3(),   // 前のコマでの機体の位置（カメラを機体について動かすため）
  drive: {
    x: 0, y: 0, yaw: 0,    // 機体の位置（CAD座標の mm）と向き（z軸まわりの角度。左に曲がるとプラス）
    move: "stop",          // いまの動き："forward" / "left" / "right" / "stop"
    demo_time: 0,          // お手本の動き（mission.json の demo）を始めてからの時間
    demo_active: false,    // お手本の動きの途中か（ボタンを押すと終わる）
    wheel_xneg: 0,         // x＜0 側のタイヤの回転角
    wheel_xpos: 0,         // x＞0 側のタイヤの回転角
  },
  // GNSS誘導・カメラ誘導（自動で走るフェーズ）の状態
  guidance: {
    done: false,           // このフェーズの目的を達成したか（GNSS：3m以内に入った／カメラ：ゴールに着いた）
    estimate: new THREE.Vector2(),   // GNSSで測った自分の位置（ずれを含む）
    estimate_timer: 0,     // 次にGNSSで位置を測るまでの時間
    random_seed: 1,        // 位置のずれを作る疑似乱数の種（毎回同じ動きになるように）
    cone_found: false,     // カメラにコーンが見えているか
  },
};

// 0〜1 の値を、a〜b の間だけなめらかに 0→1 に変える（範囲の外では 0 か 1）
function smooth_between(a, b, t) {
  const x = THREE.MathUtils.clamp((t - a) / (b - a), 0, 1);
  return x * x * (3 - 2 * x);
}

function vec3(array) {
  return new THREE.Vector3(array[0], array[1], array[2]);
}

// ---------------------------------------------------------------
// 仮の形を作る（CADがない部品。寸法はすべて mission.json の shapes から読む）
// ---------------------------------------------------------------
function build_mission_props(data) {
  const shapes = data.shapes;
  const props = {};

  // ----- キャリア（ロケットの中の筒）：半透明の円筒。機体と一緒には動かないので model_root に入れる
  const carrier_shape = shapes.carrier;
  const carrier_geometry = new THREE.CylinderGeometry(
    carrier_shape.radius, carrier_shape.radius, carrier_shape.height, 48, 1, true);
  carrier_geometry.rotateX(Math.PI / 2);   // 円筒の軸を y から z（上下）に向ける
  props.carrier = new THREE.Mesh(carrier_geometry, make_translucent_material(carrier_shape.color, carrier_shape.opacity));
  model_root.add(props.carrier);

  // ----- エンベロープ（機体を包む袋）：前と後ろの半分ずつに分け、上の線（ちょうつがい）で開く
  const env = shapes.envelope;
  props.envelope_material = make_translucent_material(env.color, env.opacity);
  props.envelope_hinge = vec3(env.center).add(new THREE.Vector3(0, 0, env.radius));   // ちょうつがいの位置
  props.envelope_front = new THREE.Group();
  props.envelope_back = new THREE.Group();
  props.envelope_front.add(new THREE.Mesh(
    make_half_cylinder_geometry(env.radius, env.length, Math.PI / 2), props.envelope_material));
  props.envelope_back.add(new THREE.Mesh(
    make_half_cylinder_geometry(env.radius, env.length, -Math.PI / 2), props.envelope_material));
  vehicle.add(props.envelope_front, props.envelope_back);

  // ----- パラシュート：六角形の傘（中心に穴）。ひもは線で描き、毎コマ位置を計算し直す
  const chute = shapes.parachute;
  const rim_radius = chute.diagonal / 2;   // 六角形の対角の半分 = 中心から角までの距離
  const canopy_geometry = new THREE.CylinderGeometry(
    chute.hole_diameter / 2, rim_radius, chute.height, HEXAGON_CORNERS, 1, true);
  canopy_geometry.rotateX(Math.PI / 2);                 // 軸を z（上下）に向ける。穴のある側が上
  canopy_geometry.translate(0, 0, chute.height / 2);    // ふち（六角形）が z = 0 に来るようにする
  props.canopy_material = new THREE.MeshStandardMaterial({
    color: chute.color, side: THREE.DoubleSide, roughness: 0.8, transparent: true, opacity: 0.95,
  });
  props.canopy = new THREE.Mesh(canopy_geometry, props.canopy_material);
  props.canopy.castShadow = true;
  // ひも：角6か所 → 結び目（6本）＋ 結び目 → エンベロープ（1本）＝ 7本の線
  const line_count = HEXAGON_CORNERS + 1;
  props.chute_lines = new THREE.LineSegments(
    new THREE.BufferGeometry().setAttribute(
      "position", new THREE.BufferAttribute(new Float32Array(line_count * 2 * 3), 3)),
    new THREE.LineBasicMaterial({ color: 0x555555, transparent: true }),
  );
  props.chute_lines.frustumCulled = false;   // 毎コマ形が変わるので、画面外の判定で消えないようにする
  vehicle.add(props.canopy, props.chute_lines);

  // ----- ニクロム線（2か所）：電流を流すと赤く光る
  const nichrome = shapes.nichrome;
  props.nichrome_material = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, emissive: 0xff2200, emissiveIntensity: 0 });
  props.nichromes = nichrome.points.map((point) => {
    const geometry = new THREE.CylinderGeometry(NICHROME_RADIUS_MM, NICHROME_RADIUS_MM, nichrome.length, 12);
    geometry.rotateZ(Math.PI / 2);   // 軸を x 方向（1st layer の前のふちに沿う向き）にする
    const mesh = new THREE.Mesh(geometry, props.nichrome_material);
    mesh.position.copy(vec3(point));
    vehicle.add(mesh);
    return mesh;
  });

  // ----- テグス（2本）：ニクロム線からエンベロープの前の面まで
  const tegus_points = [];
  for (const point of nichrome.points) {
    const p = vec3(point);
    const dz = p.z - env.center[2];
    const surface_y = env.center[1] - Math.sqrt(Math.max(env.radius ** 2 - dz ** 2, 0));
    tegus_points.push(p.x, p.y, p.z, p.x, surface_y, p.z);
  }
  props.tegus = new THREE.LineSegments(
    new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(tegus_points, 3)),
    new THREE.LineBasicMaterial({ color: 0x333333 }),
  );
  vehicle.add(props.tegus);

  // ----- スタビライザ（展開の途中だけ使う）：伸びた部分（帯）と、まだ丸まっている部分（円筒）。
  //       形は部品のスタビライザ（parts.json の stabilizer）と同じ中心線に沿わせ、伸びきったら部品に切り替える
  const stabi_part = find_part("stabilizer");
  const stabi_width = stabi_part ? stabi_part.tape.width_mm : 0;
  const stabi_material = new THREE.MeshStandardMaterial({
    color: stabi_part ? stabi_part.color : 0xdddddd, metalness: 0.4, roughness: 0.4, side: THREE.DoubleSide,
  });
  props.stabi_ribbon = new THREE.Mesh(make_ribbon_geometry(STABI_SEGMENTS), stabi_material);
  props.stabi_ribbon.frustumCulled = false;
  props.stabi_ribbon.castShadow = true;
  props.stabi_width = stabi_width;
  const coil_geometry = new THREE.CylinderGeometry(1, 1, stabi_width, 24);
  coil_geometry.rotateZ(Math.PI / 2);   // 軸を x 方向にする（大きさは scale で半径を変える）
  props.stabi_coil = new THREE.Mesh(coil_geometry, stabi_material);
  props.stabi_coil.castShadow = true;
  vehicle.add(props.stabi_ribbon, props.stabi_coil);

  // ----- GNSS誘導・カメラ誘導で使うもの（ゴールのコーンなど）
  build_guidance_props(data.guidance, props);

  props.all = [
    props.carrier, props.envelope_front, props.envelope_back, props.canopy, props.chute_lines,
    ...props.nichromes, props.tegus, props.stabi_ribbon, props.stabi_coil,
    props.goal_group, props.area_grid, props.estimate_marker, props.camera_fan,
  ];
  for (const object of props.all) object.visible = false;
  return props;
}

// ---------------------------------------------------------------
// GNSS誘導・カメラ誘導で使うものを作る（寸法・位置は mission.json の guidance から読む）
//   ゴール側のもの（コーン・3mの円・広い格子・GNSSの位置の印）は地面に置くので model_root に、
//   カメラの扇形は機体と一緒に動くので vehicle に入れる（どちらもCAD座標：z が上、−y が前）
// ---------------------------------------------------------------
const GUIDANCE_RING_DASH_MM = 160;      // 3mの円の点線の、線の長さ
const GUIDANCE_RING_SEGMENTS = 160;     // 3mの円をいくつの直線で近似するか
const GUIDANCE_GRID_STEP_MM = 1000;     // 広い格子の間隔（1m）
const ESTIMATE_MARKER_RADIUS_MM = 120;  // GNSSで測った位置の印の大きさ
const ESTIMATE_MARKER_COLOR = 0x7b4dff; // GNSSで測った位置の印の色（紫）
const CAMERA_FAN_COLOR_SEARCH = 0x8aa4c8;   // コーンが見えていないときの扇形の色
const CAMERA_FAN_COLOR_FOUND = 0x2e8b57;    // コーンが見えているときの扇形の色
const CAMERA_LENS_POSITION = [2.1, -58.5];  // レンズの先の位置（機体から見た x, y。XiaoESP32S3Sense.stl と同じ）
const GROUND_LIFT_MM = 1;               // 地面に置くものを少し浮かせて、ちらつきを防ぐ

function build_guidance_props(guidance, props) {
  const goal = guidance.goal;
  const ground_z = GROUND_Z_MM + GROUND_LIFT_MM;

  // ゴール：コーン（ConeGeometry は y 方向が高さなので、x軸まわりに回して z を高さにする）
  props.goal_group = new THREE.Group();
  const cone_geometry = new THREE.ConeGeometry(guidance.cone.radius, guidance.cone.height, 32);
  cone_geometry.rotateX(Math.PI / 2);
  const cone = new THREE.Mesh(cone_geometry, new THREE.MeshStandardMaterial({ color: guidance.cone.color, roughness: 0.6 }));
  cone.position.set(goal[0], goal[1], GROUND_Z_MM + guidance.cone.height / 2);
  cone.castShadow = true;
  props.goal_group.add(cone);
  props.goal_cone = cone;   // 機体のカメラの小窓で、コーンが見えているかを調べるのに使う

  // ゴールから3mの円（点線）
  const ring_points = [];
  for (let i = 0; i <= GUIDANCE_RING_SEGMENTS; i++) {
    const angle = (2 * Math.PI * i) / GUIDANCE_RING_SEGMENTS;
    ring_points.push(new THREE.Vector3(
      goal[0] + guidance.switch_distance_mm * Math.cos(angle),
      goal[1] + guidance.switch_distance_mm * Math.sin(angle),
      ground_z,
    ));
  }
  const ring = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(ring_points),
    new THREE.LineDashedMaterial({ color: 0xc8941f, dashSize: GUIDANCE_RING_DASH_MM, gapSize: GUIDANCE_RING_DASH_MM }),
  );
  ring.computeLineDistances();   // 点線にするために、線の長さを計算しておく
  props.goal_group.add(ring);

  // 円の外側に「3m」の文字
  const ring_label = make_ground_label(`${guidance.switch_distance_mm / 1000}m`);
  // make_ground_label は Three.js 座標用に寝かせてあるので、CAD座標では寝かせ直さない。
  // 後ろ（+y）から見たときに文字が逆さにならないよう、z軸まわりに半回転させる
  ring_label.rotation.set(0, 0, Math.PI);
  ring_label.scale.setScalar(6);
  ring_label.position.set(goal[0] + guidance.switch_distance_mm + 200, goal[1], ground_z);
  props.goal_group.add(ring_label);
  model_root.add(props.goal_group);

  // 広い格子（スタートからゴールまでを含む範囲。1mごと）
  const divisions = Math.round(guidance.area_size_mm / GUIDANCE_GRID_STEP_MM);
  props.area_grid = new THREE.GridHelper(guidance.area_size_mm, divisions, 0xaab4c3, 0xc9d1dc);
  props.area_grid.rotation.x = Math.PI / 2;   // GridHelper は y が上なので、CAD座標（z が上）に合わせる
  props.area_grid.position.set(goal[0] / 2, goal[1] / 2, ground_z);
  model_root.add(props.area_grid);

  // GNSSで測った自分の位置の印（紫の輪）
  props.estimate_marker = new THREE.Mesh(
    new THREE.RingGeometry(ESTIMATE_MARKER_RADIUS_MM * 0.6, ESTIMATE_MARKER_RADIUS_MM, 32),
    new THREE.MeshBasicMaterial({ color: ESTIMATE_MARKER_COLOR, side: THREE.DoubleSide }),
  );
  props.estimate_marker.position.z = ground_z + GROUND_LIFT_MM;
  model_root.add(props.estimate_marker);

  // カメラに見えている範囲（地面に描く扇形）。CircleGeometry の角度は +x から左回り、前（−y）は −90°
  const half_fov = THREE.MathUtils.degToRad(guidance.camera_fov_deg / 2);
  props.camera_fan_material = new THREE.MeshBasicMaterial({
    color: CAMERA_FAN_COLOR_SEARCH, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false,
  });
  props.camera_fan = new THREE.Mesh(
    new THREE.CircleGeometry(guidance.camera_range_mm, 32, -Math.PI / 2 - half_fov, half_fov * 2),
    props.camera_fan_material,
  );
  props.camera_fan.position.set(CAMERA_LENS_POSITION[0], CAMERA_LENS_POSITION[1], ground_z + GROUND_LIFT_MM);
  vehicle.add(props.camera_fan);
}

function make_translucent_material(color, opacity) {
  return new THREE.MeshStandardMaterial({
    color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, roughness: 0.5,
  });
}

// ---------------------------------------------------------------
// 半分の円筒（両端に半円のふた付き）を作る。軸は x 方向。
// 座標は「ちょうつがい（円筒の真上の線）」を原点にして作るので、
// グループごと x軸まわりに回すと、ちょうつがいを中心に開く
//   phi_start = π/2 なら前半分（y＜0）、−π/2 なら後ろ半分（y＞0）
// ---------------------------------------------------------------
function make_half_cylinder_geometry(radius, length, phi_start) {
  const half = length / 2;
  const point = (x, phi) => [x, radius * Math.cos(phi), radius * Math.sin(phi) - radius];
  const positions = [];
  for (let i = 0; i < ENVELOPE_SEGMENTS; i++) {
    const a = phi_start + (Math.PI * i) / ENVELOPE_SEGMENTS;
    const b = phi_start + (Math.PI * (i + 1)) / ENVELOPE_SEGMENTS;
    // 側面（四角形を三角形2つで）
    positions.push(...point(-half, a), ...point(half, a), ...point(half, b));
    positions.push(...point(-half, a), ...point(half, b), ...point(-half, b));
    // 両端のふた（中心は円筒の軸上）
    for (const x of [-half, half]) {
      positions.push(x, 0, -radius, ...point(x, a), ...point(x, b));
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

// ---------------------------------------------------------------
// スタビライザの帯：区間の数だけ「左右2点」を並べた細長い面。点の位置は毎コマ書き換える
// ---------------------------------------------------------------
function make_ribbon_geometry(segments) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array((segments + 1) * 2 * 3), 3));
  const indices = [];
  for (let i = 0; i < segments; i++) {
    const a = i * 2;   // 区間の始まりの左右の点：a, a+1　終わり：a+2, a+3
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  geometry.setIndex(indices);
  return geometry;
}

// ---------------------------------------------------------------
// スタビライザを、伸びた割合 deploy（0＝丸まったまま、1＝伸びきった）の形にする。
//   ホルダに押さえられた部分は最初から出ていて、そこから先が中心線に沿って伸びていく。
//   伸びきったら、帯と円筒を隠して、部品としてのスタビライザ（反り・黒い足つき）を見せる
// ---------------------------------------------------------------
let stabilizer_mesh = null;   // 部品としてのスタビライザ（一度探したら覚えておく）

function update_stabilizer(deploy) {
  const props = mission.props;
  if (!stabilizer_mesh) stabilizer_mesh = view_state.meshes.find((mesh) => mesh.userData.part_id === "stabilizer") ?? null;
  if (!stabilizer_shape) {   // スタビライザを作れなかった（エラーは表示済み）
    props.stabi_ribbon.visible = false;
    props.stabi_coil.visible = false;
    return;
  }
  const deployed = deploy >= 1;
  if (stabilizer_mesh) stabilizer_mesh.visible = deployed;
  if (deployed) {
    props.stabi_ribbon.visible = false;
    props.stabi_coil.visible = false;
    return;
  }

  const shape = stabilizer_shape;
  const extended = shape.clamp_length + (shape.total - shape.clamp_length) * deploy;   // 伸びた長さ
  const remaining = shape.total - extended;                                            // まだ丸まっている長さ
  const half_width = props.stabi_width / 2;

  // 伸びた部分（帯）
  const positions = props.stabi_ribbon.geometry.getAttribute("position");
  for (let i = 0; i <= STABI_SEGMENTS; i++) {
    const { position } = stabilizer_point_at((extended * i) / STABI_SEGMENTS);
    positions.setXYZ(i * 2, position.x - half_width, position.y, position.z);
    positions.setXYZ(i * 2 + 1, position.x + half_width, position.y, position.z);
  }
  positions.needsUpdate = true;
  props.stabi_ribbon.geometry.computeVertexNormals();
  props.stabi_ribbon.visible = true;

  // 丸まった部分（円筒）。残りが長いほど太い。帯の先の下側に付く
  const coil_radius = Math.sqrt(STABI_COIL_CORE_MM ** 2 + (remaining * STABI_COIL_THICKNESS_MM) / Math.PI);
  const tip = stabilizer_point_at(extended);
  const outward = new THREE.Vector3(0, Math.sin(tip.theta), -Math.cos(tip.theta));
  props.stabi_coil.position.copy(tip.position).addScaledVector(outward, coil_radius);
  props.stabi_coil.scale.set(1, coil_radius, coil_radius);
  props.stabi_coil.visible = remaining > 0.5;
}

// ---------------------------------------------------------------
// フェーズ番号と進み具合 t（0〜1）から、ミッションの「姿」を決める
//   ここで返す値だけで画面が決まる。各フェーズの終わり（t=1）と
//   次のフェーズの始まり（t=0）が同じ姿になるように作ってある
// ---------------------------------------------------------------
function mission_pose(phase_index, t) {
  const scene_data = mission.data.scene;
  // 遠隔操作の画面では、フェーズに関係なく「遠隔操作」の姿にする
  const action = mission.remote ? "remote" : mission.data.phases[phase_index].action;
  const stow_z = scene_data.stow_altitude_mm;
  const released_z = stow_z - scene_data.release_drop_mm;
  const descent_end_z = scene_data.descent_end_altitude_mm;
  const SHOCK_TIME = 0.2;          // 降下フェーズで、パラシュートが開ききる時刻（t）
  const FREE_FALL_DROP_MM = 150;   // パラシュートが開くまでに落ちる量
  const SHOCK_BUMP_MM = 30;        // 開いた瞬間の衝撃で、機体が引き上げられる量（見た目用）
  const TOUCHDOWN_TIME = 0.75;     // 着地フェーズで、地面に着く時刻（t）

  // 何もしなければこの姿（エンベロープに包まれて、パラシュートはたたんだまま）
  const pose = {
    position: new THREE.Vector3(), quaternion: new THREE.Quaternion(),
    carrier: false, envelope: true, envelope_open: 0, envelope_away: 0, fade: 0,
    chute_open: 0, chute_lean: 0, heat: 0, tegus: true, stabilizer: 0, drive: false,
    guidance: null,   // "gnss"（GNSS誘導）／"camera"（カメラ誘導）／"remote"（遠隔操作）／null（どれでもない）
  };

  switch (action) {
    case "stowed":
      pose.position.set(0, 0, stow_z);
      pose.quaternion.copy(STOW_ROTATION);
      pose.carrier = true;
      break;

    case "release":
      // だんだん速く落ちる（t の2乗）。後半で横向き（車軸が水平）に変わる
      pose.position.set(0, 0, stow_z - scene_data.release_drop_mm * t * t);
      pose.quaternion.copy(STOW_ROTATION).slerp(new THREE.Quaternion(), smooth_between(0.35, 1, t));
      pose.carrier = true;
      break;

    case "descent": {
      pose.chute_open = smooth_between(0, SHOCK_TIME, t);
      let z;
      if (t < SHOCK_TIME) {
        z = released_z - FREE_FALL_DROP_MM * (t / SHOCK_TIME);
      } else {
        const slow = (t - SHOCK_TIME) / (1 - SHOCK_TIME);
        z = THREE.MathUtils.lerp(released_z - FREE_FALL_DROP_MM, descent_end_z, slow);
        // 開いた瞬間の衝撃（少し引き上げられる）
        const shock = (t - SHOCK_TIME) / 0.1;
        if (shock < 1) z += SHOCK_BUMP_MM * Math.sin(Math.PI * shock);
      }
      pose.position.set(0, 0, z);
      break;
    }

    case "landing": {
      pose.chute_open = 1;
      let z;
      if (t < TOUCHDOWN_TIME) {
        z = descent_end_z * (1 - t / TOUCHDOWN_TIME);
      } else {
        // 着地して軽く跳ねる（だんだん小さく）
        const u = (t - TOUCHDOWN_TIME) / (1 - TOUCHDOWN_TIME);
        z = scene_data.bounce_height_mm * Math.abs(Math.sin(2 * Math.PI * u)) * (1 - u);
      }
      pose.position.set(0, 0, z);
      pose.chute_lean = smooth_between(TOUCHDOWN_TIME - 0.05, 1, t);
      break;
    }

    case "separation":
      pose.chute_open = 1;
      pose.chute_lean = 1;
      // ニクロム線が熱くなる → テグスが切れる → エンベロープが開く → 離れていく
      pose.heat = t < 0.4 ? smooth_between(0, 0.3, t) : 1 - smooth_between(0.4, 0.5, t);
      pose.tegus = t < 0.35;
      pose.envelope_open = smooth_between(0.4, 0.6, t);
      pose.envelope_away = smooth_between(0.55, 0.9, t);
      pose.fade = smooth_between(0.8, 1, t);
      break;

    case "stabilizer":
      pose.envelope = false;
      pose.tegus = false;
      pose.stabilizer = smooth_between(0.1, 0.8, t);
      break;

    // 走る姿（遠隔操作・GNSS誘導・カメラ誘導。"drive" は以前の「走らせてみる」フェーズ用）：位置と向きは mission.drive から
    case "remote":
    case "drive":
    case "gnss_guidance":
    case "camera_guidance":
      pose.envelope = false;
      pose.tegus = false;
      pose.stabilizer = 1;
      pose.drive = true;
      pose.position.set(mission.drive.x, mission.drive.y, 0);
      pose.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), mission.drive.yaw);
      if (action === "gnss_guidance") pose.guidance = "gnss";
      if (action === "camera_guidance") pose.guidance = "camera";
      if (action === "remote") {
        pose.guidance = "remote";   // ゴールのコーンと格子だけを出す
        apply_tip_to_pose(pose);    // 後退で転倒しているときは、車軸のまわりに回す
      }
      break;

    default:
      console.error(`mission.json の action "${action}" が分かりません`);
  }
  return pose;
}

// ---------------------------------------------------------------
// 決まった「姿」を、画面の物に当てはめる
// ---------------------------------------------------------------
function apply_mission_pose(pose) {
  const props = mission.props;
  const shapes = mission.data.shapes;
  const env = shapes.envelope;

  // 機体
  vehicle.position.copy(pose.position);
  vehicle.quaternion.copy(pose.quaternion);

  // キャリア：キャリアの中にいたときの、エンベロープの中心の位置に固定
  props.carrier.visible = pose.carrier;
  props.carrier.position.set(0, 0, mission.data.scene.stow_altitude_mm)
    .add(vec3(env.center).applyQuaternion(STOW_ROTATION));

  // エンベロープ：ちょうつがいを中心に前後へ開き、そのあと離れていく
  const show_envelope = pose.envelope && pose.fade < 1;
  const away = ENVELOPE_AWAY_SHIFT.clone().multiplyScalar(pose.envelope_away);
  const open_angle = THREE.MathUtils.degToRad(env.open_angle_deg) * pose.envelope_open;
  for (const [half, sign] of [[props.envelope_front, -1], [props.envelope_back, 1]]) {
    half.visible = show_envelope;
    half.position.copy(props.envelope_hinge).add(away);
    half.rotation.x = sign * open_angle;
  }
  props.envelope_material.opacity = env.opacity * (1 - pose.fade);

  // パラシュート
  update_parachute(pose, away);

  // ニクロム線とテグス
  for (const mesh of props.nichromes) mesh.visible = true;
  props.nichrome_material.emissiveIntensity = NICHROME_GLOW * pose.heat;
  props.tegus.visible = pose.tegus && show_envelope;

  // スタビライザ
  update_stabilizer(pose.stabilizer);

  // 誘導のフェーズだけ：ゴール・広い格子・GNSSの位置の印（GNSS誘導）・カメラの扇形（カメラ誘導）
  const guidance = mission.guidance;
  props.goal_group.visible = pose.guidance !== null;
  props.area_grid.visible = pose.guidance !== null;
  props.estimate_marker.visible = pose.guidance === "gnss";
  props.estimate_marker.position.x = guidance.estimate.x;
  props.estimate_marker.position.y = guidance.estimate.y;
  props.camera_fan.visible = pose.guidance === "camera";
  props.camera_fan_material.color.set(guidance.cone_found ? CAMERA_FAN_COLOR_FOUND : CAMERA_FAN_COLOR_SEARCH);

  // タイヤ：走行中だけ回す
  for (const mesh of view_state.meshes) {
    if (!SPIN_PART_IDS.includes(mesh.userData.part_id)) continue;
    const angle = pose.drive ? (mesh.userData.center.x < 0 ? mission.drive.wheel_xneg : mission.drive.wheel_xpos) : 0;
    set_mesh_spin(mesh, angle);
  }
}

// パラシュートの傘とひもを置く（座標は機体グループの中＝機体から見た位置）
function update_parachute(pose, envelope_away_shift) {
  const props = mission.props;
  const chute = mission.data.shapes.parachute;
  const show = pose.envelope && pose.fade < 1;
  props.canopy.visible = show;
  props.chute_lines.visible = show && pose.chute_open > 0.05;   // たたんでいる間は、ひもは見せない
  if (!show) return;

  // ひもの付け根（エンベロープの上）。分離後はエンベロープと一緒に離れていく
  const anchor = props.envelope_hinge.clone().add(envelope_away_shift);
  const folded_position = anchor.clone().add(new THREE.Vector3(0, 0, 8));
  // 開いたときの結び目の位置（風で倒れる分・離れていく分を足す）
  const open_knot = anchor.clone()
    .add(new THREE.Vector3(0, 0, chute.knot_height))
    .addScaledVector(CHUTE_LEAN_SHIFT, pose.chute_lean)
    .addScaledVector(CHUTE_AWAY_SHIFT, pose.envelope_away);
  const knot = folded_position.clone().lerp(open_knot, pose.chute_open);
  const rim_center = folded_position.clone()
    .lerp(open_knot.clone().add(new THREE.Vector3(0, 0, chute.rim_above_knot)), pose.chute_open);
  const scale = THREE.MathUtils.lerp(FOLDED_CHUTE_SCALE, 1, pose.chute_open);

  props.canopy.position.copy(rim_center);
  props.canopy.scale.setScalar(scale);
  props.canopy_material.opacity = 0.95 * (1 - pose.fade);

  // ひも：六角形の角（CylinderGeometry の角と同じ向き）→ 結び目、結び目 → 付け根
  const positions = props.chute_lines.geometry.getAttribute("position");
  const rim_radius = (chute.diagonal / 2) * scale;
  for (let i = 0; i < HEXAGON_CORNERS; i++) {
    const angle = (2 * Math.PI * i) / HEXAGON_CORNERS;
    positions.setXYZ(i * 2, rim_center.x + rim_radius * Math.sin(angle), rim_center.y - rim_radius * Math.cos(angle), rim_center.z);
    positions.setXYZ(i * 2 + 1, knot.x, knot.y, knot.z);
  }
  positions.setXYZ(HEXAGON_CORNERS * 2, knot.x, knot.y, knot.z);
  positions.setXYZ(HEXAGON_CORNERS * 2 + 1, anchor.x, anchor.y, anchor.z);
  positions.needsUpdate = true;
  props.chute_lines.material.opacity = 1 - pose.fade;
}

// ---------------------------------------------------------------
// 走行：左右のタイヤの回る速さから、機体の進み方と曲がり方を計算する
//   進む速さ = 左右のタイヤの速さの平均
//   曲がる速さ = 左右の速さの差 ÷ タイヤの間隔（右が速いと左へ曲がる）
// ---------------------------------------------------------------
const SPIN_SPEED_RATIO = 0.12;   // その場で回るときのタイヤの速さ（まっすぐ進むときに対する割合）
const WHEEL_SPEED_RATIOS = {   // [x＜0 側（前から見て右）, x＞0 側（前から見て左）] の速さの割合
  forward: () => [1, 1],
  left: (inner) => [1, inner],     // 左へ曲がる：左（x＞0側）のタイヤを遅くする
  right: (inner) => [inner, 1],
  // その場で左へ回る：左右のタイヤを逆に回す（カメラでコーンを探すとき）。
  // 速く回るとコーンを見落としやすいので、ゆっくり回す
  spin_left: () => [SPIN_SPEED_RATIO, -SPIN_SPEED_RATIO],
  backward: () => [-1, -1],        // 後退：左右のタイヤを両方とも逆に回す（遠隔操作だけで使う）
  stop: () => [0, 0],
};

// ---------------------------------------------------------------
// 後退での転倒と、前進での復帰（遠隔操作）
//   後退すると、タイヤを回した反動で車体が回り、後ろの尾（スタビライザ）が持ち上がる。
//   後退を TIP_AFTER_S 秒続けると、車体が車軸のまわりに回って、スタビライザが真上を向く（転倒）。
//   転倒しても、前進すると反動が逆向きにかかって、スタビライザが地面に戻る（復帰）。
//   動きは、実機の動画（後退 → スタビライザが真上を向く → 前進で戻る）に合わせた
// ---------------------------------------------------------------
const TIP_AFTER_S = 0.5;           // 何秒後退を続けたら転倒するか
const TIP_DURATION_S = 0.6;        // 転倒しきるまでの時間
const RECOVER_DURATION_S = 0.8;    // 前進して起き上がるまでの時間
const TIP_ANGLE_FALLBACK_DEG = 120; // スタビライザの形が分からないときの、転倒の角度

const tip_state = {
  reverse_s: 0,       // 後退を続けている時間
  progress: 0,        // 転倒の具合（0＝普通に走れる姿勢、1＝スタビライザが真上を向いた）
  tipped: false,      // 転倒しているか（前進で起き上がるまで）
  recovering: false,  // 前進して起き上がっている途中か
};
const tip_warning_el = $("tip_warning");
const tip_warning_text_el = $("tip_warning_text");
const tip_meter_bar_el = $("tip_meter_bar");

// 車軸の位置（CAD座標）：左右のタイヤの中心の平均。転倒するときは、ここを中心に回る
let axle_center = null;
function get_axle_center() {
  if (axle_center) return axle_center;
  const tires = view_state.meshes.filter((mesh) => mesh.userData.part_id.startsWith("tire_"));
  axle_center = new THREE.Vector3();
  if (tires.length === 0) return axle_center;
  for (const mesh of tires) axle_center.add(mesh.userData.center);
  axle_center.divideScalar(tires.length);
  return axle_center;
}

// 転倒しきったときの角度：スタビライザのまっすぐな部分（斜め下向き）が、真上を向くまで回す
function tip_angle_rad() {
  return stabilizer_shape
    ? Math.PI / 2 + stabilizer_shape.slope_rad
    : THREE.MathUtils.degToRad(TIP_ANGLE_FALLBACK_DEG);
}

// 転倒の具合を、機体の姿（位置と向き）に足す。
//   向き ＝ 走る向き（z軸まわり）× 転倒の向き（車軸 ＝ x軸まわり。後ろ＝+y が上＝+z へ回るのがプラス）
//   位置 ＝ 車軸の位置が動かないように、回したぶんだけずらす（タイヤは地面に着いたまま）
function apply_tip_to_pose(pose) {
  if (tip_state.progress <= 0) return;
  // 転倒はだんだん速く（倒れる感じ）、起き上がりはなめらかに
  const eased = tip_state.recovering
    ? THREE.MathUtils.smootherstep(tip_state.progress, 0, 1)
    : tip_state.progress * tip_state.progress;
  const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), tip_angle_rad() * eased);
  const pivot = get_axle_center();
  const shift = pivot.clone().sub(pivot.clone().applyQuaternion(tilt));
  pose.position.add(shift.applyQuaternion(pose.quaternion));
  pose.quaternion.multiply(tilt);
}

// 毎コマ：後退の時間を数え、転倒・復帰の動きを進める
function update_tip(dt) {
  const move = mission.drive.move;
  if (tip_state.recovering) {
    tip_state.progress = Math.max(0, tip_state.progress - dt / RECOVER_DURATION_S);
    if (tip_state.progress === 0) tip_state.recovering = false;
  } else if (tip_state.tipped) {
    tip_state.progress = Math.min(1, tip_state.progress + dt / TIP_DURATION_S);
    // 転倒しきったあとに前進すると、起き上がり始める
    if (tip_state.progress === 1 && move === "forward") {
      tip_state.tipped = false;
      tip_state.recovering = true;
    }
  } else if (move === "backward") {
    tip_state.reverse_s += dt;
    if (tip_state.reverse_s >= TIP_AFTER_S) {
      tip_state.tipped = true;
      tip_state.reverse_s = 0;
      set_drive_move("stop", false);   // 転倒したらタイヤは止める（前進を押すまで待つ）
    }
  } else {
    tip_state.reverse_s = 0;   // 後退をやめたら、数え直し
  }
  update_tip_ui();
}

// 後退中・転倒中・起き上がり中の注意を出す
function update_tip_ui() {
  const backing = mission.drive.move === "backward" && !tip_state.tipped && !tip_state.recovering;
  const show = backing || tip_state.tipped || tip_state.recovering;
  tip_warning_el.classList.toggle("hidden", !show);
  if (!show) return;
  let text;
  let meter;
  if (tip_state.recovering) {
    text = "前進して起き上がっています（スタビライザが地面に戻ります）";
    meter = tip_state.progress;
  } else if (tip_state.tipped) {
    text = "⚠ 転倒しました（スタビライザが真上を向いています）。「↑ 前進」（↑キー・Wキー）を押すと起き上がります";
    meter = 1;
  } else {
    const left_s = Math.max(0, TIP_AFTER_S - tip_state.reverse_s);
    text = `⚠ 後退中：続けると転倒します（あと ${left_s.toFixed(1)} 秒）`;
    meter = tip_state.reverse_s / TIP_AFTER_S;
  }
  if (tip_warning_text_el.textContent !== text) tip_warning_text_el.textContent = text;
  tip_meter_bar_el.style.width = `${meter * 100}%`;
}

function reset_tip() {
  Object.assign(tip_state, { reverse_s: 0, progress: 0, tipped: false, recovering: false });
  update_tip_ui();
}

function update_drive(dt) {
  const drive = mission.drive;
  const phase = mission.data.phases[mission.phase_index];

  // お手本の動き（demo）の途中なら、時間からいまの動きを決める
  if (drive.demo_active) {
    drive.demo_time += dt;
    let elapsed = 0;
    let move = null;
    for (const item of phase.demo ?? []) {
      elapsed += item.seconds;
      if (drive.demo_time < elapsed || item.seconds === 0) { move = item.move; break; }
    }
    if (move === null || move === "stop") drive.demo_active = false;
    set_drive_move(move ?? "stop", false);
  }

  integrate_drive(dt, mission.data.drive.speed_mm_s, mission.data.drive.turn_inner_ratio);
}

// ---------------------------------------------------------------
// いまの動き（drive.move）のまま dt 秒進めて、機体の位置・向き・タイヤの角度を更新する
//   speed_mm_s：まっすぐ進むときの速さ（誘導のフェーズでは、見やすいように速くする）
//   inner_ratio：曲がるとき、内側のタイヤを外側の何倍の速さにするか（1に近いほどゆるやかに曲がる）
// ---------------------------------------------------------------
function integrate_drive(dt, speed_mm_s, inner_ratio) {
  const drive = mission.drive;
  const config = mission.data.drive;
  const ratio_fn = WHEEL_SPEED_RATIOS[drive.move] ?? WHEEL_SPEED_RATIOS.stop;
  const [ratio_xneg, ratio_xpos] = ratio_fn(inner_ratio);
  const base_rate = speed_mm_s / config.wheel_radius_mm;   // タイヤの回る速さ（ラジアン毎秒）
  const rate_xneg = base_rate * ratio_xneg;
  const rate_xpos = base_rate * ratio_xpos;
  drive.wheel_xneg += rate_xneg * dt;
  drive.wheel_xpos += rate_xpos * dt;

  const speed_xneg = rate_xneg * config.wheel_radius_mm;
  const speed_xpos = rate_xpos * config.wheel_radius_mm;
  const forward_speed = (speed_xneg + speed_xpos) / 2;
  const turn_rate = (speed_xneg - speed_xpos) / config.track_mm;
  drive.yaw += turn_rate * dt;
  // 前は −y。向き yaw のときの前方向 = (sin yaw, −cos yaw)
  drive.x += Math.sin(drive.yaw) * forward_speed * dt;
  drive.y += -Math.cos(drive.yaw) * forward_speed * dt;
}

const DRIVE_LABELS = { forward: "前進中", left: "左旋回中", right: "右旋回中", backward: "後退中", stop: "止まっています" };

function set_drive_move(move, by_user) {
  const drive = mission.drive;
  // 転倒中・起き上がり中は、前進（起き上がる）と止めるだけを受け付ける
  const tipping = tip_state.tipped || tip_state.recovering;
  if (by_user && tipping && move !== "forward" && move !== "stop") return;
  if (by_user) drive.demo_active = false;   // ボタンを押したら、お手本の動きは終わり
  if (drive.move === move && !by_user) return;
  drive.move = move;
  drive_controls_el.querySelectorAll("button[data-move]").forEach((button) => {
    button.classList.toggle("active", button.dataset.move === move && move !== "stop");
  });
  const left_speed = move === "left" ? "遅い" : "速い";
  const right_speed = move === "right" ? "遅い" : "速い";
  if (move === "stop") {
    drive_status_el.textContent = `いま：${DRIVE_LABELS.stop}`;
  } else if (move === "backward") {
    drive_status_el.textContent = `いま：${DRIVE_LABELS.backward}（左右のタイヤを逆向きに回す）`;
  } else {
    drive_status_el.textContent = `いま：${DRIVE_LABELS[move]}（左のタイヤ ${left_speed}・右のタイヤ ${right_speed}）${drive.demo_active ? "　※お手本の動き" : ""}`;
  }
  update_tip_ui();
}

// ---------------------------------------------------------------
// 遠隔操作を、ラジコンのように「押している間だけ」動かす（#15）
//   ・キーボード：矢印キー・W A S D を押している間だけ動き、離すと止まる
//   ・ボタン　　：長押しすると押している間だけ動き、指（マウス）を離すと止まる
//                 短く押したとき（タップ・クリック）は、今までどおりその動きが続く（「止める」で止まる）
//   いくつか同時に押しているときは、あとから押したものを優先し、離したら前に押していたものに戻る
// ---------------------------------------------------------------
const DRIVE_KEY_MOVES = {
  ArrowUp: "forward", KeyW: "forward",
  ArrowDown: "backward", KeyS: "backward",
  ArrowLeft: "left", KeyA: "left",
  ArrowRight: "right", KeyD: "right",
};
const TAP_MAX_MS = 300;   // これより短く押したら「タップ」（動きを続ける）、長ければ「長押し」（離すと止まる）

// いま押されているもの（押した順）。source はキーの名前か、"pointer_番号"
let held_drive_inputs = [];

function remote_active() {
  return view_state.mode === "mission" && mission.remote;
}

// 押した：その動きにする
function press_drive_input(source, move) {
  held_drive_inputs = held_drive_inputs.filter((input) => input.source !== source);
  held_drive_inputs.push({ source, move });
  set_drive_move(move, true);
}

// 離した：まだ押しているものがあればその動きに戻し、なければ止める
//   keep_moving = true（ボタンのタップ）なら、止めずにいまの動きを続ける
function release_drive_input(source, keep_moving = false) {
  const was_held = held_drive_inputs.some((input) => input.source === source);
  held_drive_inputs = held_drive_inputs.filter((input) => input.source !== source);
  if (!was_held || keep_moving || !remote_active()) return;
  const latest = held_drive_inputs[held_drive_inputs.length - 1];
  set_drive_move(latest ? latest.move : "stop", true);
}

// 遠隔操作をやめたとき・ウィンドウから離れたとき：押しているものを全部忘れる
function clear_drive_inputs() {
  held_drive_inputs = [];
}

// キーボード。遠隔操作の画面のときだけ使い、使ったら true を返す（← → でフェーズが変わらないように）
function handle_drive_key(event, pressed) {
  const move = DRIVE_KEY_MOVES[event.code];
  if (!move || !remote_active()) return false;
  if (event.ctrlKey || event.altKey || event.metaKey) return false;   // ブラウザのショートカットは邪魔しない
  event.preventDefault();   // 矢印キーでページがスクロールしないように
  if (!pressed) {
    release_drive_input(event.code);
  } else if (!event.repeat) {   // 押しっぱなしで繰り返し届くイベントは無視する
    press_drive_input(event.code, move);
  }
  return true;
}

// 動きのボタン（前進・左旋回・右旋回・後退）を、タップでも長押しでも使えるようにする
function setup_drive_button(button) {
  const move = button.dataset.move;
  let pressed_at = 0;

  button.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;   // 左クリック・指だけ
    try {
      button.setPointerCapture(event.pointerId);   // ボタンの外で離しても、離したことが分かるように
    } catch (err) {
      // まれに捕まえられないことがある（その指がもう離れているなど）。捕まえなくても動きは決められる
    }
    pressed_at = performance.now();
    press_drive_input(`pointer_${event.pointerId}`, move);
  });
  const on_release = (event) => {
    const is_tap = performance.now() - pressed_at < TAP_MAX_MS;
    release_drive_input(`pointer_${event.pointerId}`, is_tap && event.type === "pointerup");
  };
  button.addEventListener("pointerup", on_release);
  button.addEventListener("pointercancel", on_release);
  // Tab キーで選んで Enter・スペースを押したとき（マウス・指ではない click）は、今までどおり動きを続ける
  button.addEventListener("click", (event) => {
    if (event.detail === 0) set_drive_move(move, true);
  });
  // スマホで長押ししたときに、メニュー（コピーなど）が出ないようにする
  button.addEventListener("contextmenu", (event) => event.preventDefault());
}

function reset_drive() {
  Object.assign(mission.drive, { x: 0, y: 0, yaw: 0, wheel_xneg: 0, wheel_xpos: 0, demo_time: 0, move: null });
  reset_tip();   // スタート位置に戻すときは、転倒していても普通の姿勢に戻す
  mission.drive.demo_active = Boolean(mission.data.phases[mission.phase_index].demo);
  set_drive_move("stop", false);   // move を null にしてあるので、表示も必ず更新される
}

// =============================================================
// GNSS誘導・カメラ誘導（自動で走る）
//   GNSS誘導：決まった間隔（mission.json の gnss_update_s）で「ずれを含んだ自分の位置」を測り、そこからゴールの方向を計算して向きを直す。
//             測った位置でゴールまで3m以内に入ったら終わり
//   カメラ誘導：カメラに見える範囲（扇形）にコーンがなければ、その場で回って探す。
//             見つけたら、コーンが真ん中に来るように向きを直しながら近づく
// =============================================================
const GUIDANCE_RANDOM_SEED = 20261119;   // 位置のずれの並び（毎回同じ動きにするための種）

// 角度を −π〜π の範囲に直す（「左に350°」を「右に10°」として扱うため）
function wrap_angle(angle) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

// 疑似乱数（0〜1）。決まった式で作るので、何度見ても同じ動きになる
function guidance_random() {
  const g = mission.guidance;
  g.random_seed = (g.random_seed * 16807) % 2147483647;
  return g.random_seed / 2147483647;
}

// 地点 (from_x, from_y) から見たゴールの向きと、機体の向きとの差（左がプラス）
//   前は −y なので、向き yaw の前方向は (sin yaw, −cos yaw)
function heading_error_to_goal(from_x, from_y) {
  const goal = mission.data.guidance.goal;
  const desired_yaw = Math.atan2(goal[0] - from_x, -(goal[1] - from_y));
  return wrap_angle(desired_yaw - mission.drive.yaw);
}

// 機体の中心から、いちばん前（−y 方向）の点までの長さ（mm）。部品の形から1回だけ計算する
let vehicle_front_extent_mm = null;

function get_vehicle_front_extent() {
  if (vehicle_front_extent_mm === null) {
    let min_y = 0;
    for (const mesh of view_state.meshes) {
      const box = mesh.geometry.boundingBox.clone().applyMatrix4(mesh.userData.base_matrix);
      min_y = Math.min(min_y, box.min.y);
    }
    vehicle_front_extent_mm = -min_y;
  }
  return vehicle_front_extent_mm;
}

// 止まる距離：機体の前面がコーン（いちばん太い底の円）に触れるときの、機体の中心とコーンの中心の距離
function contact_distance_mm() {
  return mission.data.guidance.cone.radius + get_vehicle_front_extent();
}

function distance_to_goal(from_x, from_y) {
  const goal = mission.data.guidance.goal;
  return Math.hypot(goal[0] - from_x, goal[1] - from_y);
}

// GNSSで位置を測る（本当の位置に、ランダムなずれを足す）
function measure_gnss_position() {
  const g = mission.guidance;
  const error = mission.data.guidance.gnss_error_mm;
  const angle = 2 * Math.PI * guidance_random();
  const length = error * Math.sqrt(guidance_random());   // 円の中に一様にばらつくように
  g.estimate.set(mission.drive.x + length * Math.cos(angle), mission.drive.y + length * Math.sin(angle));
}

// 誘導のフェーズに入ったときの準備
//   continue_from_gnss：GNSS誘導を最後まで見てからカメラ誘導に来たときは、その位置から続ける
function reset_guidance(action, continue_from_gnss) {
  const g = mission.guidance;
  const config = mission.data.guidance;
  g.done = false;
  g.cone_found = false;
  g.estimate_timer = 0;
  g.random_seed = GUIDANCE_RANDOM_SEED;

  if (!continue_from_gnss) {
    Object.assign(mission.drive, { x: 0, y: 0, yaw: 0, wheel_xneg: 0, wheel_xpos: 0 });
    if (action === "camera_guidance") {
      // スタートとゴールを結ぶ線の上で、ゴールから3mの点に置く。向きは、ゴールから少しずらす
      const goal = config.goal;
      const ratio = 1 - config.switch_distance_mm / distance_to_goal(0, 0);
      mission.drive.x = goal[0] * ratio;
      mission.drive.y = goal[1] * ratio;
      mission.drive.yaw = 0;
      mission.drive.yaw = wrap_angle(
        heading_error_to_goal(mission.drive.x, mission.drive.y) - THREE.MathUtils.degToRad(config.camera_start_heading_deg));
    }
  }
  measure_gnss_position();
  mission.drive.move = "stop";
  update_guidance_status(action);
}

function update_guidance(dt, action) {
  const g = mission.guidance;
  const config = mission.data.guidance;
  const drive = mission.drive;
  const tolerance = THREE.MathUtils.degToRad(config.heading_tolerance_deg);

  if (!g.done) {
    if (action === "gnss_guidance") {
      // 決まった間隔で位置を測り直す。向きの判断は、測った位置（ずれを含む）を使う
      g.estimate_timer += dt;
      if (g.estimate_timer >= config.gnss_update_s) {
        g.estimate_timer = 0;
        measure_gnss_position();
      }
      if (distance_to_goal(g.estimate.x, g.estimate.y) <= config.switch_distance_mm) {
        g.done = true;
        drive.move = "stop";
      } else {
        const error = heading_error_to_goal(g.estimate.x, g.estimate.y);
        drive.move = Math.abs(error) <= tolerance ? "forward" : (error > 0 ? "left" : "right");
      }
    } else {
      // カメラ：機体の本当の位置から見たコーンの向きが、見える範囲（扇形）に入っているか
      const error = heading_error_to_goal(drive.x, drive.y);
      const distance = distance_to_goal(drive.x, drive.y);
      g.cone_found = Math.abs(error) <= THREE.MathUtils.degToRad(config.camera_fov_deg / 2)
        && distance <= config.camera_range_mm;
      if (distance <= contact_distance_mm()) {
        // 機体の前面がコーンに触れたらゴール
        g.done = true;
        drive.move = "stop";
      } else if (!g.cone_found) {
        drive.move = "spin_left";
      } else {
        drive.move = Math.abs(error) <= tolerance ? "forward" : (error > 0 ? "left" : "right");
      }
    }
  }
  integrate_drive(dt, config.display_speed_mm_s, config.turn_inner_ratio);
  update_guidance_status(action);
}

// 右の欄に、いまの誘導の様子を出す
const GUIDANCE_MOVE_TEXT = {
  forward: "ゴールの方向へまっすぐ進んでいます",
  left: "左へ向きを直しています",
  right: "右へ向きを直しています",
  spin_left: "その場で回って、コーンを探しています",
  stop: "止まっています",
};

function update_guidance_status(action) {
  const g = mission.guidance;
  const drive = mission.drive;
  let text;
  if (action === "gnss_guidance") {
    const measured = distance_to_goal(g.estimate.x, g.estimate.y) / 1000;
    text = g.done
      ? `GNSSで測ったゴールまでの距離が3m以内になりました（${measured.toFixed(1)} m）。カメラ誘導に切り替えます`
      : `GNSSで測ったゴールまでの距離：${measured.toFixed(1)} m ／ ${GUIDANCE_MOVE_TEXT[drive.move] ?? ""}`;
  } else {
    if (g.done) {
      text = "機体の前面がコーンに触れました。ゴールです！";
    } else {
      text = `${g.cone_found ? "コーンが見えています" : "コーンが見えていません"} ／ ${GUIDANCE_MOVE_TEXT[drive.move] ?? ""}`;
    }
  }
  if (guidance_status_el.textContent !== text) guidance_status_el.textContent = text;
}

// =============================================================
// 遠隔操作（ボタンで走らせる）。ミッションの流れ（フェーズ）とは別の画面で、
// 下の帯の「遠隔操作」ボタンで切り替える。GNSS誘導と同じスタート地点から、ゴールのコーンを目指す
// =============================================================

// 遠隔操作の画面に切り替える（on = true）／ミッションの流れに戻る（on = false）
function set_remote(on) {
  if (on) {
    set_autoplay(false);
    mission.remote = true;
    reset_drive();                     // スタート地点（GNSS誘導と同じ）に置き、止めておく
    mission.drive.demo_active = false; // 遠隔操作では、お手本の動きはしない
    mission.remote_last_distance = Infinity;
    render_remote_ui();
    apply_mission_pose(mission_pose(mission.phase_index, 0));
    follow_vehicle_with_camera();
    stop_camera_motion();
    mission.follow_camera = true;
    move_camera_relative(mission.data.remote.camera);
    update_remote_status();
  } else {
    // go_to_phase の中で mission.remote を false に戻し、画面も切り替える
    go_to_phase(mission.phase_index);
  }
}

// 遠隔操作かどうかに合わせて、右の欄と下の帯の表示を切り替える
function render_remote_ui() {
  const on = mission.remote;
  clear_drive_inputs();   // 切り替えたら、押しているキー・ボタンは忘れる
  panel_remote_el.classList.toggle("hidden", !on);
  panel_sequence_el.classList.toggle("hidden", on);
  document.querySelectorAll("#bar_mission .sequence_only").forEach((element) => {
    element.classList.toggle("hidden", on);
  });
  btn_remote_el.setAttribute("aria-pressed", String(on));
  btn_remote_el.textContent = on ? "↩ ミッションに戻る" : "🎮 遠隔操作";
  if (on) panel_remote_el.closest(".panel").scrollTop = 0;
  if (view_state.mode === "mission") update_location_hash();   // URL も #remote ⇔ #mission-… に（#16）
}

// 毎コマ：ボタンの動きのまま走らせ、前面がコーンに触れたら止める
function update_remote(dt) {
  const config = mission.data.remote;
  integrate_drive(dt, config.speed_mm_s, config.turn_inner_ratio);
  update_tip(dt);   // 後退の時間を数え、転倒・復帰を進める

  const distance = distance_to_goal(mission.drive.x, mission.drive.y);
  // コーンに近づく向きに動いていて、前面が触れたら止める（離れる向きなら、そのまま動ける）
  if (distance <= contact_distance_mm() && distance < mission.remote_last_distance && mission.drive.move !== "stop") {
    set_drive_move("stop", false);
  }
  mission.remote_last_distance = distance;
  update_remote_status();
}

function update_remote_status() {
  const distance = distance_to_goal(mission.drive.x, mission.drive.y);
  const text = distance <= contact_distance_mm() + 1
    ? "機体の前面がコーンに触れました。ゴールです！"
    : `ゴールのコーンまで：${(distance / 1000).toFixed(1)} m`;
  if (remote_status_el.textContent !== text) remote_status_el.textContent = text;
}

// ---------------------------------------------------------------
// フェーズを切り替える
// ---------------------------------------------------------------
function go_to_phase(index) {
  // 遠隔操作の画面から、フェーズの操作（キーボードの ← → など）をしたときは、ミッションの流れに戻る
  if (mission.remote) {
    mission.remote = false;
    render_remote_ui();
  }
  const phases = mission.data.phases;
  index = THREE.MathUtils.clamp(index, 0, phases.length - 1);
  // GNSS誘導を最後まで見てから、すぐ次のカメラ誘導に来たか（そのときは、止まった位置から続ける）
  const previous = phases[mission.phase_index];
  const continue_from_gnss = previous.action === "gnss_guidance" && mission.guidance.done
    && index === mission.phase_index + 1;
  mission.phase_index = index;
  mission.time_s = 0;
  mission.hold_s = 0;
  const phase = phases[index];
  if (phase.action === "drive") reset_drive();
  if (phase.action === "gnss_guidance" || phase.action === "camera_guidance") {
    reset_guidance(phase.action, continue_from_gnss);
  }
  // 最後のフェーズでは、自動再生は終わり
  if (index === phases.length - 1) set_autoplay(false);

  // すぐに新しい姿にして、カメラも機体について動かす
  apply_mission_pose(mission_pose(index, 0));
  follow_vehicle_with_camera();

  stop_camera_motion();
  if (mission.follow_camera && phase.camera) move_camera_relative(phase.camera);
  render_phase_panel();
  update_location_hash();   // URL も、このフェーズに合わせる（#16）
}

// ---------------------------------------------------------------
// 毎コマの処理：時間を進め、姿を決め、カメラを機体について動かす
// ---------------------------------------------------------------
function update_mission(dt) {
  if (view_state.mode !== "mission" || !mission.data) return;
  const phases = mission.data.phases;
  const phase = phases[mission.phase_index];
  const duration = phase.duration_s * motion_factor;

  // 遠隔操作：ボタンの操作で走らせるだけ（フェーズは進めない）
  if (mission.remote) {
    update_remote(dt);
    apply_mission_pose(mission_pose(mission.phase_index, 0));
    follow_vehicle_with_camera();
    return;
  }

  mission.time_s += dt;
  let t = Math.min(mission.time_s / duration, 1);
  if (phase.action === "drive") update_drive(dt);
  if (phase.action === "gnss_guidance" || phase.action === "camera_guidance") {
    update_guidance(dt, phase.action);
    t = mission.guidance.done ? 1 : 0;   // 誘導のフェーズは、目的を達成したら「終わり」（自動再生で次へ進む）
  }
  apply_mission_pose(mission_pose(mission.phase_index, t));
  follow_vehicle_with_camera();

  // 自動再生：フェーズが終わったら少し待って次へ
  if (mission.playing && t >= 1 && mission.phase_index < phases.length - 1) {
    mission.hold_s += dt;
    if (mission.hold_s >= mission.data.scene.hold_between_phases_s) go_to_phase(mission.phase_index + 1);
  }
}

// 機体が動いた分だけ、カメラと注視点も一緒に動かす（自分で回した向きは保ったまま）
function follow_vehicle_with_camera() {
  model_root.updateMatrixWorld(true);
  const now = vehicle.getWorldPosition(new THREE.Vector3());
  const delta = now.clone().sub(mission.vehicle_world);
  camera.position.add(delta);
  controls.target.add(delta);
  mission.vehicle_world.copy(now);
}

// ---------------------------------------------------------------
// 機体から見た位置で、おすすめの視点へなめらかに移る（機体が動いていても追いかける）
//   camera_spec.offset：機体から見たカメラの位置、look：機体から見た注視点（どちらもCAD座標）
// ---------------------------------------------------------------
function move_camera_relative(camera_spec) {
  const from_offset = camera.position.clone().sub(mission.vehicle_world);
  const from_look = controls.target.clone().sub(mission.vehicle_world);
  const to_look = cad_to_three(camera_spec.look);
  const to_offset = cad_to_three(camera_spec.offset).sub(to_look)
    .multiplyScalar(narrow_view_scale()).add(to_look);   // 縦長の画面では引く
  start_tween(
    "camera",
    CAMERA_MOVE_DURATION_S * motion_factor,
    (t) => {
      camera.position.lerpVectors(from_offset, to_offset, t).add(mission.vehicle_world);
      controls.target.lerpVectors(from_look, to_look, t).add(mission.vehicle_world);
    },
  );
}

// ---------------------------------------------------------------
// 自動再生のオン・オフ
// ---------------------------------------------------------------
function set_autoplay(playing) {
  mission.playing = playing;
  btn_autoplay_el.setAttribute("aria-pressed", String(playing));
  btn_autoplay_el.textContent = playing ? "■ 自動再生を止める" : "▶ 自動再生";
}

function toggle_autoplay() {
  if (mission.playing) {
    set_autoplay(false);
    return;
  }
  set_autoplay(true);
  // 最後のフェーズで押されたら、最初から再生する
  if (mission.phase_index === mission.data.phases.length - 1) go_to_phase(0);
}

// ---------------------------------------------------------------
// モードに入る・出る
// ---------------------------------------------------------------
function enter_mission() {
  // 部品を見るモードの分解などを戻してから始める
  const zero = new THREE.Vector3();
  for (const mesh of view_state.meshes) set_mesh_offset(mesh, zero);
  apply_appearance();
  for (const object of mission.props.all) object.visible = true;
  mission.vehicle_world.set(0, 0, 0);
  mission.follow_camera = true;
  go_to_phase(mission.phase_index);
}

function leave_mission() {
  set_autoplay(false);
  mission.remote = false;   // 次にミッションモードに入ったときは、ミッションの流れから始める
  render_remote_ui();
  vehicle.position.set(0, 0, 0);
  vehicle.quaternion.identity();
  mission.vehicle_world.set(0, 0, 0);   // 影を作る光も原点に戻る
  for (const mesh of view_state.meshes) {
    if (mesh.userData.spin !== 0) set_mesh_spin(mesh, 0);
  }
  if (mission.props) {
    for (const object of mission.props.all) object.visible = false;
  }
}

// ---------------------------------------------------------------
// 右の欄に、いまのフェーズの説明を出す
// ---------------------------------------------------------------
function render_phase_panel() {
  const phases = mission.data.phases;
  const index = mission.phase_index;
  const phase = phases[index];

  phase_counter_el.textContent = `フェーズ ${phase.id}（${index + 1} / ${phases.length}）`;
  phase_title_el.textContent = phase.title;
  phase_text_el.textContent = phase.text;
  set_optional_text(phase_detail_el, phase.detail);
  set_optional_text(phase_provisional_el, phase.provisional ? `仮：${phase.provisional}` : "");
  guidance_status_el.classList.toggle("hidden", phase.action !== "gnss_guidance" && phase.action !== "camera_guidance");

  // フェーズの一覧と、下の帯の丸印
  phase_list_el.innerHTML = "";
  phase_dots_el.innerHTML = "";
  phases.forEach((item, i) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.textContent = `${item.id}．${item.title}`;
    if (i === index) button.setAttribute("aria-current", "step");
    button.addEventListener("click", () => go_to_phase(i));
    li.appendChild(button);
    phase_list_el.appendChild(li);

    const dot = document.createElement("button");
    dot.title = `フェーズ ${item.id}：${item.title}`;
    dot.setAttribute("aria-label", dot.title);
    if (i < index) dot.classList.add("done");
    if (i === index) dot.setAttribute("aria-current", "step");
    dot.addEventListener("click", () => go_to_phase(i));
    phase_dots_el.appendChild(dot);
  });

  btn_prev_phase_el.disabled = index === 0;
  btn_next_phase_el.disabled = index === phases.length - 1;
  btn_phase_view_el.classList.toggle("attention", !mission.follow_camera);
  panel_detail_el.closest(".panel").scrollTop = 0;
}

// =============================================================
// 部品を見るモード
// =============================================================

// ---------------------------------------------------------------
// 「仮」の小さな札を作る
// ---------------------------------------------------------------
function make_provisional_tag(part) {
  const tag = document.createElement("span");
  tag.className = "tag_provisional";
  tag.textContent = "仮";
  tag.title = part.provisional;
  return tag;
}

// ---------------------------------------------------------------
// 右の欄に部品の一覧（色見本つき）を出す。
// クリックすると、その部品の説明が一覧の中で開く（開いている部品をもう一度押すと閉じる）
// ---------------------------------------------------------------
const legend_items = new Map();   // 部品の id → 一覧の行（<li>）。説明欄を差し込む場所を探すのに使う

function render_legend(parts) {
  legend_el.innerHTML = "";
  legend_items.clear();
  for (const part of parts) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.className = "legend_button";
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-controls", "panel_detail");
    button.addEventListener("click", () => {
      select_part(view_state.selected_id === part.id ? null : part.id);
    });

    // 開いているか閉じているかを示す三角（CSS で向きを変える）
    const arrow = document.createElement("span");
    arrow.className = "legend_arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "▸";
    button.appendChild(arrow);

    const chip = document.createElement("span");
    chip.className = "chip";
    chip.style.background = part.color;
    button.appendChild(chip);

    const label = document.createElement("span");
    label.textContent = `${part.name} ×${part.count}`;
    button.appendChild(label);

    if (part.provisional) button.appendChild(make_provisional_tag(part));
    item.appendChild(button);
    legend_el.appendChild(item);
    legend_items.set(part.id, item);
  }
}

// ---------------------------------------------------------------
// 分解表示の準備：各部品を「機体の中心から、その部品の中心へ向かう向き」に
// 離すので、その向きと距離（中心どうしの差）を部品ごとに求めておく（CAD座標）
// ---------------------------------------------------------------
function compute_explode_offsets(meshes) {
  const model_center = new THREE.Box3();
  for (const mesh of meshes) {
    model_center.union(mesh.geometry.boundingBox.clone().applyMatrix4(mesh.userData.base_matrix));
  }
  const center = model_center.getCenter(new THREE.Vector3());
  for (const mesh of meshes) {
    mesh.userData.explode_offset = mesh.userData.center.clone().sub(center).multiplyScalar(EXPLODE_SCALE);
  }
}

// 分解の量に合わせて、各部品の位置を決め直す
function update_explode_positions() {
  const offset = new THREE.Vector3();
  for (const mesh of view_state.meshes) {
    set_mesh_offset(mesh, offset.copy(mesh.userData.explode_offset).multiplyScalar(view_state.explode_ratio));
  }
}

// ---------------------------------------------------------------
// 部品を選ぶ（part_id が null なら選択を解除して、説明を閉じる）
// ---------------------------------------------------------------
function select_part(part_id) {
  view_state.selected_id = part_id;
  if (part_id === null) view_state.isolate = false;   // 選択をやめたら全部品を表示に戻す
  render_parts_panel();
  apply_appearance();
  update_location_hash();   // URL も、選んだ部品に合わせる（#16）
}

// ---------------------------------------------------------------
// 右の欄を、いまの状態に合わせて書き直す。
// 一覧はいつも出したまま、選んだ部品の行のすぐ下に説明欄（panel_detail）を移して開く
// ---------------------------------------------------------------
function render_parts_panel() {
  const part = find_part(view_state.selected_id);
  for (const [id, item] of legend_items) {
    const is_open = Boolean(part) && id === part.id;
    item.classList.toggle("open", is_open);
    item.querySelector(".legend_button").setAttribute("aria-expanded", String(is_open));
  }
  panel_detail_el.classList.toggle("hidden", !part);
  if (!part) return;

  // 選んだ部品の行の中（ボタンの下）へ説明欄を移す
  const item = legend_items.get(part.id);
  if (item && panel_detail_el.parentElement !== item) item.appendChild(panel_detail_el);

  detail_role_el.textContent = part.role;
  detail_material_el.textContent = part.material;
  detail_count_el.textContent =
    part.count > 1 ? `${part.count}個（光っている${part.count}個すべて）` : `${part.count}個`;

  // 仮の形・仮の値の部品は、そのことをはっきり書く
  set_optional_text(detail_provisional_el, part.provisional ? `仮：${part.provisional}` : "");

  btn_isolate_el.setAttribute("aria-pressed", String(view_state.isolate));
  btn_isolate_el.textContent = view_state.isolate ? "すべての部品を表示する" : "この部品だけ表示";

  // 開いた説明が見えるように、一覧をその位置までスクロールする（3D画面で選んだときのため）
  (item ?? panel_detail_el).scrollIntoView({ block: "nearest", behavior: "smooth" });
}

// =============================================================
// マウス・指・キーボードの操作
// =============================================================

// ---------------------------------------------------------------
// 画面上の点（マウスの位置）の先にある部品を探す。なければ null
// ---------------------------------------------------------------
const raycaster = new THREE.Raycaster();
const pointer_ndc = new THREE.Vector2();

function pick_mesh(client_x, client_y) {
  // 画面の座標を、-1〜1 の範囲（正規化デバイス座標）に直す
  const rect = renderer.domElement.getBoundingClientRect();
  pointer_ndc.x = ((client_x - rect.left) / rect.width) * 2 - 1;
  pointer_ndc.y = -((client_y - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer_ndc, camera);

  // 隠している部品には当たらないようにする（Raycaster は非表示の物にも当たるため）
  const hits = raycaster.intersectObjects(view_state.meshes, false);
  const hit = hits.find((h) => h.object.visible);
  return hit ? hit.object : null;
}

// ---------------------------------------------------------------
// 3Dビューの上での操作
//   ・押した位置からほとんど動かずに離したら「クリック」→ 部品を選ぶ（部品を見るモードのみ）
//   ・動かしたら回転のドラッグなので何もしない（OrbitControls に任せる）
//   ・マウスを乗せているときは、部品名をツールチップで出す（全モード）
// ---------------------------------------------------------------
let pointer_down_position = null;
let hover_request = null;   // 次の描画のときに調べるマウス位置

function setup_pointer_events() {
  const canvas = renderer.domElement;

  canvas.addEventListener("pointerdown", (event) => {
    pointer_down_position = { x: event.clientX, y: event.clientY };
    hide_tooltip();
  });

  canvas.addEventListener("pointerup", (event) => {
    if (!pointer_down_position) return;
    const moved = Math.hypot(event.clientX - pointer_down_position.x, event.clientY - pointer_down_position.y);
    pointer_down_position = null;
    if (moved > CLICK_TOLERANCE_PX || view_state.mode !== "parts") return;

    const mesh = pick_mesh(event.clientX, event.clientY);
    // 何もないところをクリックしたら選択を解除（「この部品だけ表示」中は解除しない）
    if (mesh) {
      select_part(mesh.userData.part_id);
    } else if (!view_state.isolate) {
      select_part(null);
    }
  });

  canvas.addEventListener("pointermove", (event) => {
    // 指の操作やドラッグ中はツールチップを出さない
    if (event.pointerType !== "mouse" || event.buttons !== 0) return;
    hover_request = { x: event.clientX, y: event.clientY };
  });

  canvas.addEventListener("pointerleave", () => {
    hover_request = null;
    hide_tooltip();
  });

  // 自分で視点を動かし始めたら、自動の動きを止め、以後は手順を変えても視点を動かさない
  controls.addEventListener("start", on_user_view_change);

  setup_pinch_zoom();
}

// ---------------------------------------------------------------
// タッチパッドのピンチで、指を広げた分だけ拡大する（#22）
//   ・Chrome・Edge・Firefox：ピンチは「Ctrl 付きのホイール」として届く
//   ・Mac の Safari　　　　：ピンチは gesturestart / gesturechange として届く（倍率 scale 付き）
//   普通のマウスホイールも、ここで自分で計算する（#24。理由は on_viewport_wheel の説明）
//   スマホの2本指は、今までどおり OrbitControls に任せる
// ---------------------------------------------------------------
let active_touch_count = 0;     // 画面に触れている指の数（スマホで Safari の gesture と二重に拡大しないため）
let gesture_start_distance = 0; // Safari のピンチを始めたときの、カメラと注視点の距離

function setup_pinch_zoom() {
  const canvas = renderer.domElement;

  // OrbitControls も canvas でホイールを受け取るので、親の viewport で先に（capture で）受け取る
  viewport_el.addEventListener("wheel", on_viewport_wheel, { capture: true, passive: false });

  canvas.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "touch") active_touch_count += 1;
  });
  const release_touch = (event) => {
    if (event.pointerType === "touch") active_touch_count = Math.max(0, active_touch_count - 1);
  };
  canvas.addEventListener("pointerup", release_touch);
  canvas.addEventListener("pointercancel", release_touch);

  canvas.addEventListener("gesturestart", on_gesture_start);
  canvas.addEventListener("gesturechange", on_gesture_change);
  canvas.addEventListener("gestureend", on_gesture_end);
}

// ズームしてよい状態か（OrbitControls の設定に合わせる）
function can_zoom() {
  return controls.enabled && controls.enableZoom;
}

// カメラと注視点の距離を変える（向きは変えない）。OrbitControls の距離の上下限も守る
function set_camera_distance(distance) {
  const clamped = THREE.MathUtils.clamp(distance, controls.minDistance, controls.maxDistance);
  const offset = camera.position.clone().sub(controls.target);
  if (offset.lengthSq() === 0) return;   // カメラと注視点が重なっていると向きが決まらない
  camera.position.copy(controls.target).addScaledVector(offset.normalize(), clamped);
  controls.update();
}

// ホイール（ピンチ＝Ctrl 付きと、普通のマウスホイールの両方）で、カメラを寄せる・離す
//   普通のホイールも OrbitControls に任せない（#24）。OrbitControls（three.js 0.160.0）は
//   ホイールの量を「100 × devicePixelRatio を整数に切り捨てた値」で割るので、
//   ブラウザの表示倍率を下げて devicePixelRatio が1より小さくなると 0 で割ってしまい、カメラが壊れる
function on_viewport_wheel(event) {
  // 3Dの画面以外（右上の ViewCube など）の上では何もしない
  if (event.target !== renderer.domElement || !can_zoom()) return;
  event.preventDefault();             // ページのスクロール・ページ全体の拡大を止める
  event.stopImmediatePropagation();   // OrbitControls のホイールの処理を動かさない

  const delta_px = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * WHEEL_LINE_HEIGHT_PX : event.deltaY;
  // deltaY が正（手前に回す・指を閉じる）→ 倍率が1より大きい → 距離が伸びる（離れる）
  const distance_scale = event.ctrlKey ? pinch_distance_scale(delta_px) : mouse_wheel_distance_scale(delta_px);

  controls.dispatchEvent({ type: "start" });   // マウスで回したときと同じく、自動の視点の移動を止める
  set_camera_distance(camera.position.distanceTo(controls.target) * distance_scale);
  controls.dispatchEvent({ type: "end" });
}

// タッチパッドのピンチ：指を広げた分だけ寄る（#22）
function pinch_distance_scale(delta_px) {
  const delta = THREE.MathUtils.clamp(delta_px, -MAX_PINCH_WHEEL_DELTA, MAX_PINCH_WHEEL_DELTA);
  return Math.exp(delta / PINCH_WHEEL_DELTA_PER_E);
}

// 普通のマウスホイール：1目盛り（deltaY ＝ 100）で、OrbitControls と同じ 0.95 倍ずつ寄る・離れる
//   画面の細かさ（devicePixelRatio）では割らないので、どの画面・表示倍率でも同じ速さになる
function mouse_wheel_distance_scale(delta_px) {
  const notches = THREE.MathUtils.clamp(delta_px / WHEEL_DELTA_PER_NOTCH, -MAX_WHEEL_NOTCHES, MAX_WHEEL_NOTCHES);
  return Math.pow(WHEEL_ZOOM_RATIO_PER_NOTCH, -notches * controls.zoomSpeed);
}

function on_gesture_start(event) {
  // スマホの Safari では、2本指のタッチでも gesture が来る。そちらは OrbitControls が拡大するので何もしない
  if (active_touch_count > 0 || !can_zoom()) return;
  event.preventDefault();
  gesture_start_distance = camera.position.distanceTo(controls.target);
  controls.dispatchEvent({ type: "start" });
}

function on_gesture_change(event) {
  if (active_touch_count > 0 || !can_zoom() || gesture_start_distance <= 0) return;
  event.preventDefault();
  // event.scale は、ピンチを始めてからの指の開き具合（2なら2倍に広げた）。広げた分だけ寄る
  set_camera_distance(gesture_start_distance / event.scale);
}

function on_gesture_end(event) {
  if (gesture_start_distance <= 0) return;   // スマホの2本指など、ここで始めていないピンチ
  event.preventDefault();
  gesture_start_distance = 0;
  controls.dispatchEvent({ type: "end" });
}

// ---------------------------------------------------------------
// 自分で視点を動かしたとき（マウス・指・ViewCube）：自動の視点の移動を止め、
// 「おすすめの視点に戻す」を目立たせる
// ---------------------------------------------------------------
function on_user_view_change() {
  stop_camera_motion();
  if (view_state.mode === "assembly" && view_state.follow_camera) {
    view_state.follow_camera = false;
    render_step_buttons();
  }
  if (view_state.mode === "mission" && mission.follow_camera) {
    mission.follow_camera = false;
    btn_phase_view_el.classList.add("attention");
  }
}

// ---------------------------------------------------------------
// ViewCube の ⌂ ボタン：いまのモードの「おすすめの視点に戻す」と同じことをする
// ---------------------------------------------------------------
function go_home_view() {
  if (view_state.mode === "assembly") btn_step_view_el.click();
  else if (view_state.mode === "mission") btn_phase_view_el.click();
  else $("btn_reset_view").click();
}

// ---------------------------------------------------------------
// ViewCube（右上の、視点を切り替える立方体）を用意する。中身は viewcube.js
// 版の番号を付けて読み込み、更新したときに古いファイルが使われないようにする
// ---------------------------------------------------------------
let view_cube = null;

async function setup_view_cube() {
  try {
    const { create_view_cube } = await import(`./viewcube.js${VERSION_QUERY}`);
    view_cube = create_view_cube({
      main_camera: camera,
      controls,
      container: $("view_cube"),
      home_button: $("btn_view_home"),
      on_view_change: on_user_view_change,
      on_home: go_home_view,
    });
  } catch (err) {
    // 立方体がなくても、ほかの操作はできるので、知らせるだけにする
    console.error("ViewCube を用意できませんでした", err);
    $("view_cube").classList.add("hidden");
  }
}

// ---------------------------------------------------------------
// キーボード：← → で手順を移動、Esc で選択の解除・写真を閉じる
//   遠隔操作の画面では、矢印キー・W A S D で機体を走らせる（#15。handle_drive_key）
// ---------------------------------------------------------------
function setup_keyboard() {
  window.addEventListener("keyup", (event) => {
    handle_drive_key(event, false);
  });
  // キーを押したままほかのウィンドウへ移ると keyup が届かないので、止めておく
  window.addEventListener("blur", () => {
    const was_holding = held_drive_inputs.length > 0;
    clear_drive_inputs();
    if (was_holding && remote_active()) set_drive_move("stop", true);
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!lightbox_el.classList.contains("hidden")) {
        close_lightbox();
      } else if (view_state.mode === "parts") {
        select_part(null);
      }
      return;
    }
    // スライダーなどを操作中の矢印キーは、そちらに任せる
    const tag = event.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (handle_drive_key(event, true)) return;   // 遠隔操作の画面なら、キーで走らせる
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    if (view_state.mode === "assembly") go_to_step(view_state.step_index + step);
    if (view_state.mode === "mission") go_to_phase(mission.phase_index + step);
  });
}

// ---------------------------------------------------------------
// ツールチップ（マウスを乗せた部品の名前）
// 部品探しは少し重いので、マウスが動くたびではなく描画1回につき1回だけ行う
// ---------------------------------------------------------------
function update_tooltip() {
  if (!hover_request) return;
  const { x, y } = hover_request;
  hover_request = null;

  const mesh = pick_mesh(x, y);
  if (!mesh) {
    hide_tooltip();
    renderer.domElement.style.cursor = "";
    return;
  }
  const rect = viewport_el.getBoundingClientRect();
  tooltip_el.textContent = find_part(mesh.userData.part_id).name;
  tooltip_el.style.left = `${x - rect.left}px`;
  tooltip_el.style.top = `${y - rect.top}px`;
  tooltip_el.classList.remove("hidden");
  // 部品を見るモードではクリックできることを、指の形のカーソルで示す
  renderer.domElement.style.cursor = view_state.mode === "parts" ? "pointer" : "";
}

function hide_tooltip() {
  tooltip_el.classList.add("hidden");
}

// ---------------------------------------------------------------
// ボタン・スライダーなどを動くようにする
// ---------------------------------------------------------------
function setup_controls() {
  // モード切り替え
  document.querySelectorAll(".mode[data-mode]").forEach((button) => {
    button.addEventListener("click", () => set_mode(button.dataset.mode));
  });

  // 組み立てモード
  btn_prev_step_el.addEventListener("click", () => go_to_step(view_state.step_index - 1));
  btn_next_step_el.addEventListener("click", () => go_to_step(view_state.step_index + 1));
  btn_step_view_el.addEventListener("click", () => {
    view_state.follow_camera = true;
    render_step_buttons();
    const step = view_state.steps[view_state.step_index];
    if (step && step.camera) move_camera_to(step.camera);
  });
  lightbox_el.addEventListener("click", close_lightbox);

  // ミッションモード
  btn_prev_phase_el.addEventListener("click", () => go_to_phase(mission.phase_index - 1));
  btn_next_phase_el.addEventListener("click", () => go_to_phase(mission.phase_index + 1));
  btn_autoplay_el.addEventListener("click", toggle_autoplay);
  $("btn_replay_phase").addEventListener("click", () => go_to_phase(mission.phase_index));
  btn_phase_view_el.addEventListener("click", () => {
    mission.follow_camera = true;
    btn_phase_view_el.classList.remove("attention");
    // 遠隔操作の画面なら遠隔操作の視点、そうでなければいまのフェーズの視点
    const spec = mission.remote ? mission.data.remote.camera : mission.data.phases[mission.phase_index].camera;
    if (spec) move_camera_relative(spec);
  });
  btn_remote_el.addEventListener("click", () => set_remote(!mission.remote));
  drive_controls_el.querySelectorAll("button[data-move]").forEach((button) => {
    if (button.dataset.move === "stop") {
      // 「止める」：押しているものも忘れて、止める
      button.addEventListener("click", () => {
        clear_drive_inputs();
        set_drive_move("stop", true);
      });
    } else {
      setup_drive_button(button);   // タップで動きを続ける・長押しで押している間だけ動く（#15）
    }
  });
  $("btn_drive_reset").addEventListener("click", () => {
    reset_drive();
    mission.drive.demo_active = false;
    mission.remote_last_distance = Infinity;
    update_remote_status();
  });

  // 部品を見るモード
  $("btn_reset_view").addEventListener("click", reset_view);

  btn_isolate_el.addEventListener("click", () => {
    view_state.isolate = !view_state.isolate;
    render_parts_panel();
    apply_appearance();
  });

  explode_slider_el.addEventListener("input", () => {
    view_state.explode_ratio = Number(explode_slider_el.value) / EXPLODE_SLIDER_MAX;
    update_explode_positions();
  });

  translucent_check_el.addEventListener("change", () => {
    view_state.translucent = translucent_check_el.checked;
    apply_appearance();
  });
}

// =============================================================
// 描画
// =============================================================

// ---------------------------------------------------------------
// 機体のカメラ（XIAO ESP32S3 Sense）から見た景色を、左上の小窓に描く（カメラ誘導・遠隔操作のとき）
//   レンズの位置に2台目のカメラを置き、前（−y）を向ける。画角は mission.json の camera_fov_deg（横の角度）。
//   機体の子にするので、走る・曲がる・転倒するときも一緒に動く。
//   コーンがカメラに映っていて、見える距離（camera_range_mm）以内なら、小窓の中のコーンに枠を付ける
// ---------------------------------------------------------------
const ONBOARD_ASPECT = 4 / 3;        // カメラの画像の縦横比（OV2640。style.css の .onboard_screen と同じ）
const ONBOARD_NEAR_MM = 5;           // これより近い物は映さない（機体の部品が映り込まないように）
const ONBOARD_FAR_MM = 30000;        // これより遠い物は映さない
const ONBOARD_LENS_AHEAD_MM = 2;     // レンズの先より少し前にカメラを置く（ケースの中が映らないように）
const CONE_OUTLINE_POINTS = 12;      // コーンの底の円を、何点で囲んで枠を求めるか
const CONE_BOX_MARGIN = 0.04;        // コーンの枠を少し大きくする量（小窓の幅に対する割合）

const onboard_view_el = $("onboard_view");
const onboard_screen_el = $("onboard_screen");
const onboard_box_el = $("onboard_box");
const onboard_label_el = $("onboard_label");
const onboard_status_el = $("onboard_status");
const onboard_camera = new THREE.PerspectiveCamera(45, ONBOARD_ASPECT, ONBOARD_NEAR_MM, ONBOARD_FAR_MM);
let onboard_ready = false;

// 機体の部品とミッションのデータがそろってから、レンズの位置と向き・画角を決める
function setup_onboard_camera() {
  const config = mission.data.guidance;
  // 横の画角から、縦の画角を求める（PerspectiveCamera の fov は縦の角度）
  const half_horizontal = THREE.MathUtils.degToRad(config.camera_fov_deg / 2);
  onboard_camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(half_horizontal) / ONBOARD_ASPECT));
  onboard_camera.updateProjectionMatrix();

  // レンズの高さは、カメラの部品の中心の高さにする（レンズは前を水平に向いている、と仮定）
  const camera_part = view_state.meshes.find((mesh) => mesh.userData.part_id === "camera_module");
  const lens = new THREE.Vector3(
    CAMERA_LENS_POSITION[0],
    CAMERA_LENS_POSITION[1] - ONBOARD_LENS_AHEAD_MM,
    camera_part ? camera_part.userData.center.z : 0,
  );
  // 機体の中（CAD座標）で、前（−y）を向き、上が +z になる向きにする
  const look = new THREE.Matrix4().lookAt(lens, lens.clone().add(new THREE.Vector3(0, -1, 0)), new THREE.Vector3(0, 0, 1));
  onboard_camera.position.copy(lens);
  onboard_camera.quaternion.setFromRotationMatrix(look);
  vehicle.add(onboard_camera);
  onboard_ready = true;
}

// 小窓を出す場面か：ミッションモードの、カメラ誘導のフェーズか遠隔操作
function onboard_view_wanted() {
  if (!onboard_ready || view_state.mode !== "mission" || !mission.data) return false;
  return mission.remote || mission.data.phases[mission.phase_index].action === "camera_guidance";
}

function render_onboard_view() {
  const show = onboard_view_wanted();
  onboard_view_el.classList.toggle("hidden", !show);
  if (!show) return;

  // 小窓の枠の内側が、3Dの画面のどこにあるか（WebGL は下から上へ数えるので、上下を入れかえる）
  const canvas_rect = renderer.domElement.getBoundingClientRect();
  const screen_rect = onboard_screen_el.getBoundingClientRect();
  const x = screen_rect.left + onboard_screen_el.clientLeft - canvas_rect.left;
  const top = screen_rect.top + onboard_screen_el.clientTop - canvas_rect.top;
  const width = onboard_screen_el.clientWidth;
  const height = onboard_screen_el.clientHeight;
  const y = canvas_rect.height - top - height;

  // 地面の扇形（見える範囲）は、カメラから見ると邪魔なので隠す。
  // 影はメインの画面を描いたときに計算済みなので、もう一度は計算しない（重くしないため）
  const fan = mission.props.camera_fan;
  const fan_visible = fan.visible;
  fan.visible = false;
  renderer.shadowMap.autoUpdate = false;
  renderer.setScissorTest(true);
  renderer.setScissor(x, y, width, height);
  renderer.setViewport(x, y, width, height);
  renderer.render(scene, onboard_camera);
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, canvas_rect.width, canvas_rect.height);
  renderer.shadowMap.autoUpdate = true;
  fan.visible = fan_visible;

  update_onboard_cone_box();
}

// コーンが映っているか調べ、映っていれば小窓の中のコーンに枠を付ける
const cone_point = new THREE.Vector3();
function update_onboard_cone_box() {
  const cone = mission.props.goal_cone;
  const config = mission.data.guidance;
  const radius = config.cone.radius;
  const half_height = config.cone.height / 2;

  // コーンの底の円の点と、てっぺんを、小窓の中の位置（-1〜1）に直す
  let min_x = Infinity, max_x = -Infinity, min_y = Infinity, max_y = -Infinity;
  let in_view = false;
  const add_point = (local) => {
    cone_point.copy(local);
    cone.localToWorld(cone_point);
    cone_point.project(onboard_camera);
    if (cone_point.z < -1 || cone_point.z > 1) return;   // カメラの後ろ・遠すぎる点は使わない
    if (Math.abs(cone_point.x) <= 1 && Math.abs(cone_point.y) <= 1) in_view = true;
    min_x = Math.min(min_x, cone_point.x); max_x = Math.max(max_x, cone_point.x);
    min_y = Math.min(min_y, cone_point.y); max_y = Math.max(max_y, cone_point.y);
  };
  for (let i = 0; i < CONE_OUTLINE_POINTS; i++) {
    const angle = (2 * Math.PI * i) / CONE_OUTLINE_POINTS;
    add_point(new THREE.Vector3(radius * Math.cos(angle), radius * Math.sin(angle), -half_height));
  }
  add_point(new THREE.Vector3(0, 0, half_height));

  // 見える距離（camera_range_mm）より遠いと、映っていても「見つけた」にはしない
  const lens_world = onboard_camera.getWorldPosition(new THREE.Vector3());
  const cone_world = cone.getWorldPosition(new THREE.Vector3());
  const found = in_view && lens_world.distanceTo(cone_world) <= config.camera_range_mm;

  onboard_box_el.classList.toggle("hidden", !found);
  if (found) {
    // -1〜1 の位置を、小窓の左上からの割合（%）に直す（y は上がプラスなので入れかえる）
    const left = THREE.MathUtils.clamp((min_x + 1) / 2 - CONE_BOX_MARGIN, 0, 1);
    const right = THREE.MathUtils.clamp((max_x + 1) / 2 + CONE_BOX_MARGIN, 0, 1);
    const box_top = THREE.MathUtils.clamp((1 - max_y) / 2 - CONE_BOX_MARGIN, 0, 1);
    const bottom = THREE.MathUtils.clamp((1 - min_y) / 2 + CONE_BOX_MARGIN, 0, 1);
    onboard_box_el.style.left = `${left * 100}%`;
    onboard_box_el.style.top = `${box_top * 100}%`;
    onboard_box_el.style.width = `${(right - left) * 100}%`;
    onboard_box_el.style.height = `${(bottom - box_top) * 100}%`;
  }
  const text = found ? "コーンを見つけた" : "コーンを探しています";
  if (onboard_status_el.textContent !== text) onboard_status_el.textContent = text;
  onboard_label_el.classList.toggle("found", found);
}

// 画面の大きさが変わったら描画サイズを合わせる
function resize_renderer() {
  const width = viewport_el.clientWidth;
  const height = viewport_el.clientHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), MAX_FRAME_DT_S);
  update_mission(dt);   // 機体を動かす（カメラも一緒に動く）。視点の移動（tween）で上書きできるよう先に行う
  update_tweens(dt);
  update_auto_rotate(dt);
  // 影を作る光を機体について動かす（遠くへ走っても影が出るように）
  sun.target.position.copy(mission.vehicle_world);
  sun.position.copy(mission.vehicle_world).add(SUN_OFFSET);
  // ViewCube で回している途中は、OrbitControls の慣性で向きが戻らないように更新しない
  if (!view_cube || !view_cube.is_moving()) controls.update(dt);
  update_tooltip();
  renderer.render(scene, camera);
  render_onboard_view();   // 左上の小窓（機体のカメラの景色）。出さない場面では何もしない
  if (view_cube) view_cube.update(dt);   // 右上の立方体（メインのカメラと同じ向きで描く）
}

// =============================================================
// はじめに実行する処理
// =============================================================
// =============================================================
// URL で見せる画面を指定する（#16）。URL の「#」から後ろに、いまの画面を書く
//   #assembly-4-2         組み立ての手順 4-2（steps.json の id）
//   #mission-7            ミッションのフェーズ 7（mission.json の id）
//   #parts-camera_module  部品を見るモードで、その部品（parts.json の id）を選ぶ。#parts だけなら選ばない
//   #remote               遠隔操作
//   ・画面を切り替えたら、アドレスバーの URL も合わせて変える（history.replaceState を使い、戻るの履歴は増やさない）
//   ・ない番号・ない部品・読めない書き方のときは、エラーにせず、そのモードの最初（読めなければ最初の画面）を出す
// =============================================================
let location_hash_ready = false;   // 最初の画面を出し終わるまでは、URL を書き換えない（開いた URL を消さないため）
const COPY_DONE_SHOW_MS = 1800;    // 「コピーしました」を出しておく時間

// いまの画面を表す「#…」を作る
function current_location_hash() {
  const mode = view_state.mode;
  if (mode === "assembly") {
    const step = view_state.steps[view_state.step_index];
    return step ? `#assembly-${step.id}` : "#assembly";
  }
  if (mode === "parts") {
    return view_state.selected_id ? `#parts-${view_state.selected_id}` : "#parts";
  }
  if (mission.remote) return "#remote";
  const phase = mission.data?.phases[mission.phase_index];
  return phase ? `#mission-${phase.id}` : "#mission";
}

// 画面を切り替えたあとに呼ぶ：アドレスバーの URL を、いまの画面に合わせる
function update_location_hash() {
  if (!location_hash_ready) return;
  const hash = current_location_hash();
  if (location.hash === hash) return;
  try {
    history.replaceState(null, "", hash);
  } catch (err) {
    // 書き換えられない開き方（一部のプレビューなど）のときは、URL はそのままにする
  }
}

// 「#…」を読み、見せる画面を返す。読めなければ null
function parse_location_hash(hash) {
  let text;
  try {
    text = decodeURIComponent(hash.replace(/^#/, ""));
  } catch (err) {
    return null;   // 「%」の書き方がおかしい
  }
  if (text === "remote") return { mode: "mission", remote: true };
  const match = text.match(/^(assembly|mission|parts)(?:-(.+))?$/);
  if (!match) return null;
  const [, mode, id] = match;
  if (mode === "assembly") {
    const index = view_state.steps.findIndex((step) => step.id === id);
    return { mode, step_index: Math.max(0, index) };   // ない手順なら最初の手順
  }
  if (mode === "mission") {
    const index = mission.data.phases.findIndex((phase) => phase.id === id);
    return { mode, phase_index: Math.max(0, index) };   // ないフェーズなら最初のフェーズ
  }
  return { mode, part_id: find_part(id) ? id : null };   // ない部品なら、選ばずに一覧だけ
}

// URL の「#…」の画面を出す。出せたら true
function apply_location_hash() {
  const target = parse_location_hash(location.hash);
  if (!target) return false;
  if (target.mode === "assembly") {
    view_state.step_index = target.step_index;
    set_mode("assembly");   // おすすめの視点から、その手順を見せる
  } else if (target.mode === "parts") {
    set_mode("parts");
    select_part(target.part_id);
  } else {
    if (!target.remote) mission.phase_index = target.phase_index;
    set_mode("mission");
    if (target.remote) set_remote(true);
  }
  return true;
}

// 「この画面のリンクをコピー」ボタン
function setup_copy_link() {
  const button = $("btn_copy_link");
  const done_el = $("copy_link_done");
  let hide_timer = 0;
  button.addEventListener("click", async () => {
    update_location_hash();
    const url = location.href;
    let ok = true;
    try {
      await navigator.clipboard.writeText(url);
    } catch (err) {
      ok = copy_text_fallback(url);   // 古いブラウザ・https でない開き方のとき
    }
    done_el.textContent = ok ? "リンクをコピーしました" : "コピーできませんでした（アドレスバーの URL を使ってください）";
    clearTimeout(hide_timer);
    hide_timer = setTimeout(() => { done_el.textContent = ""; }, COPY_DONE_SHOW_MS);
  });
}

// navigator.clipboard が使えないときのコピー（見えない入力欄に入れて、選んでコピーする）
function copy_text_fallback(text) {
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch (err) {
    ok = false;
  }
  field.remove();
  return ok;
}

async function main() {
  new ResizeObserver(resize_renderer).observe(viewport_el);
  resize_renderer();
  setup_environment();
  hint_el.textContent = HINTS[view_state.mode];
  animate();

  let parts, placements, steps, mission_data;
  try {
    [parts, placements, steps, mission_data] = await Promise.all([
      load_json(PARTS_URL), load_json(PLACEMENTS_URL), load_json(STEPS_URL), load_json(MISSION_URL),
    ]);
  } catch (err) {
    loading_text_el.textContent = "データを読み込めませんでした";
    show_error(err.message);
    if (location.protocol === "file:") {
      show_error("ファイルを直接開くと読み込めません。py -m http.server 8000 で開いてください（README.md参照）");
    }
    return;
  }

  view_state.parts = parts;
  view_state.steps = steps;
  render_legend(parts);
  const meshes = await load_and_place_parts(parts, placements);
  meshes.push(...add_generated_parts(parts, meshes));   // スタビライザ（STLなし）は、ホルダの位置から形を作る
  view_state.meshes = meshes;
  compute_explode_offsets(meshes);
  assign_steps_to_meshes(steps, meshes);

  // 機体全体の大きさを測って、視点を合わせる
  model_root.updateMatrixWorld(true);
  model_box = new THREE.Box3().setFromObject(model_root);
  reset_view();

  // ミッションモードの準備（仮の形は、機体の大きさを測ったあとに作る）
  mission.data = mission_data;
  mission.props = build_mission_props(mission_data);
  setup_onboard_camera();   // 機体のカメラ（小窓）：部品とミッションのデータがそろってから

  setup_controls();
  setup_pointer_events();
  setup_keyboard();
  await setup_view_cube();
  setup_copy_link();
  // URL に「#手順・フェーズ・部品」があればその画面、なければ最初の画面（#16）
  if (!apply_location_hash()) set_mode(view_state.mode);
  location_hash_ready = true;
  update_location_hash();
  // 開いたあとに URL の「#…」を書き換えた・リンクを押したときも、その画面へ移る
  //   読めない書き方のときは画面を変えず、URL をいまの画面の書き方に直す
  window.addEventListener("hashchange", () => {
    if (!apply_location_hash()) update_location_hash();
  });

  // エラーがなければ読み込み表示を消す（エラーがあれば残して読めるようにする）
  if (loading_errors_el.children.length === 0) {
    loading_el.classList.add("hidden");
  } else {
    loading_text_el.textContent = "一部の部品・データを読み込めませんでした";
  }

  // 確認・デバッグ用（ブラウザの開発者ツールから触れるようにする）
  window.viewer = {
    scene, camera, controls, model_root, meshes, parts, placements, steps,
    view_state, select_part, pick_mesh, go_to_step, set_mode,
    mission, go_to_phase, mission_pose, vehicle,
  };
}

main();
