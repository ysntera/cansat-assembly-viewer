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
const STABI_SEGMENTS = 40;          // スタビライザの帯を何区間に分けて曲げるか
const STABI_COIL_CORE_MM = 3;       // 丸まったスタビライザの、いちばん内側の半径
const STABI_COIL_THICKNESS_MM = 1.2; // 丸まったテープ1周ぶんの厚み（見た目用）
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
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = placement.name;
    mesh.userData.part_id = part.id;
    mesh.matrixAutoUpdate = false;               // 行列を直接与えるので自動計算を止める
    mesh.userData.base_matrix = make_placement_matrix(placement);   // 組み上がった位置
    mesh.userData.offset = new THREE.Vector3();  // 組み上がった位置からのずれ（CAD座標のmm）
    mesh.userData.spin = 0;                      // 車軸まわりの回転角（走行でタイヤを回すときに使う）
    // 組み上がった状態での部品の中心（CAD座標）
    mesh.userData.center = geometry.boundingBox.clone()
      .applyMatrix4(mesh.userData.base_matrix)
      .getCenter(new THREE.Vector3());
    mesh.matrix.copy(mesh.userData.base_matrix);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    vehicle.add(mesh);
    meshes.push(mesh);
  }
  return meshes;
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
  stabi_curvature: 0,      // スタビライザの曲がり具合（先が地面に届くように計算で決める）
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

  // ----- スタビライザ：伸びた部分（曲がった帯）と、まだ丸まっている部分（円筒）
  const stabi = shapes.stabilizer;
  const stabi_material = new THREE.MeshStandardMaterial({
    color: stabi.color, metalness: 0.4, roughness: 0.4, side: THREE.DoubleSide,
  });
  props.stabi_ribbon = new THREE.Mesh(make_ribbon_geometry(STABI_SEGMENTS), stabi_material);
  props.stabi_ribbon.frustumCulled = false;
  props.stabi_ribbon.castShadow = true;
  const coil_geometry = new THREE.CylinderGeometry(1, 1, stabi.width, 24);
  coil_geometry.rotateZ(Math.PI / 2);   // 軸を x 方向にする（大きさは scale で半径を変える）
  props.stabi_coil = new THREE.Mesh(coil_geometry, stabi_material);
  props.stabi_coil.castShadow = true;
  vehicle.add(props.stabi_ribbon, props.stabi_coil);
  mission.stabi_curvature = solve_stabilizer_curvature(stabi);

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
// スタビライザの形（円弧）。取り付け点から後ろ（+y）へ、だんだん下に曲がる帯。
//   u：取り付け点からの長さ（mm）、curvature：曲がり具合（1mm進むごとに何ラジアン曲がるか）
//   返す値：その点の位置と、進む向きの角度（y方向から測って、上向きがプラス）
// ---------------------------------------------------------------
function stabilizer_point(stabi, curvature, u) {
  const anchor = vec3(stabi.anchor);
  const theta0 = THREE.MathUtils.degToRad(stabi.start_angle_deg);
  const theta = theta0 - curvature * u;
  if (Math.abs(curvature) < 1e-9) {
    return { position: anchor.add(new THREE.Vector3(0, u * Math.cos(theta0), u * Math.sin(theta0))), theta };
  }
  // 曲がり具合が一定の線（円弧）を、長さ u まで進んだ点（向きを積分した式）
  const y = (Math.sin(theta0) - Math.sin(theta)) / curvature;
  const z = (Math.cos(theta) - Math.cos(theta0)) / curvature;
  return { position: anchor.add(new THREE.Vector3(0, y, z)), theta };
}

// 伸びきったとき、先が地面（z = GROUND_Z_MM）に届くような曲がり具合を、二分法（範囲を半分ずつ狭める方法）で探す
const BISECTION_STEPS = 40;
const LOWEST_POINT_SAMPLES = 100;

function solve_stabilizer_curvature(stabi) {
  const theta0 = THREE.MathUtils.degToRad(stabi.start_angle_deg);
  const lowest_z = (curvature) => {
    let lowest = Infinity;
    for (let i = 0; i <= LOWEST_POINT_SAMPLES; i++) {
      lowest = Math.min(lowest, stabilizer_point(stabi, curvature, (stabi.length * i) / LOWEST_POINT_SAMPLES).position.z);
    }
    return lowest;
  };
  // 曲げすぎない上限：先がちょうど真下を向く曲がり具合
  let high = (Math.PI / 2 + theta0) / stabi.length;
  let low = 0;
  if (lowest_z(low) <= GROUND_Z_MM) return 0;        // まっすぐでも届く
  if (lowest_z(high) > GROUND_Z_MM) return high;     // 届かない（いちばん下まで曲げた形にする）
  for (let i = 0; i < BISECTION_STEPS; i++) {
    const middle = (low + high) / 2;
    if (lowest_z(middle) > GROUND_Z_MM) low = middle; else high = middle;
  }
  return high;
}

// スタビライザを、伸びた割合 deploy（0＝丸まったまま、1＝伸びきった）の形にする
function update_stabilizer(deploy) {
  const stabi = mission.data.shapes.stabilizer;
  const props = mission.props;
  const extended = stabi.length * deploy;          // 伸びた長さ
  const remaining = stabi.length - extended;       // まだ丸まっている長さ
  const half_width = stabi.width / 2;

  // 伸びた部分（帯）
  const positions = props.stabi_ribbon.geometry.getAttribute("position");
  for (let i = 0; i <= STABI_SEGMENTS; i++) {
    const { position } = stabilizer_point(stabi, mission.stabi_curvature, (extended * i) / STABI_SEGMENTS);
    positions.setXYZ(i * 2, position.x - half_width, position.y, position.z);
    positions.setXYZ(i * 2 + 1, position.x + half_width, position.y, position.z);
  }
  positions.needsUpdate = true;
  props.stabi_ribbon.geometry.computeVertexNormals();
  props.stabi_ribbon.visible = extended > 0.5;

  // 丸まった部分（円筒）。残りが長いほど太い。帯の先の、曲がりの外側（下側）に付く
  const coil_radius = Math.sqrt(STABI_COIL_CORE_MM ** 2 + (remaining * STABI_COIL_THICKNESS_MM) / Math.PI);
  const tip = stabilizer_point(stabi, mission.stabi_curvature, extended);
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
      if (action === "remote") pose.guidance = "remote";   // ゴールのコーンと格子だけを出す
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
  stop: () => [0, 0],
};

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

const DRIVE_LABELS = { forward: "前進中", left: "左旋回中", right: "右旋回中", stop: "止まっています" };

function set_drive_move(move, by_user) {
  const drive = mission.drive;
  if (by_user) drive.demo_active = false;   // ボタンを押したら、お手本の動きは終わり
  if (drive.move === move && !by_user) return;
  drive.move = move;
  drive_controls_el.querySelectorAll("button[data-move]").forEach((button) => {
    button.classList.toggle("active", button.dataset.move === move && move !== "stop");
  });
  const left_speed = move === "left" ? "遅い" : "速い";
  const right_speed = move === "right" ? "遅い" : "速い";
  drive_status_el.textContent = move === "stop"
    ? `いま：${DRIVE_LABELS.stop}`
    : `いま：${DRIVE_LABELS[move]}（左のタイヤ ${left_speed}・右のタイヤ ${right_speed}）${drive.demo_active ? "　※お手本の動き" : ""}`;
}

function reset_drive() {
  Object.assign(mission.drive, { x: 0, y: 0, yaw: 0, wheel_xneg: 0, wheel_xpos: 0, demo_time: 0, move: null });
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
  panel_remote_el.classList.toggle("hidden", !on);
  panel_sequence_el.classList.toggle("hidden", on);
  document.querySelectorAll("#bar_mission .sequence_only").forEach((element) => {
    element.classList.toggle("hidden", on);
  });
  btn_remote_el.setAttribute("aria-pressed", String(on));
  btn_remote_el.textContent = on ? "↩ ミッションに戻る" : "🎮 遠隔操作";
  if (on) panel_remote_el.closest(".panel").scrollTop = 0;
}

// 毎コマ：ボタンの動きのまま走らせ、前面がコーンに触れたら止める
function update_remote(dt) {
  const config = mission.data.remote;
  integrate_drive(dt, config.speed_mm_s, config.turn_inner_ratio);

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
  controls.addEventListener("start", () => {
    stop_camera_motion();
    if (view_state.mode === "assembly" && view_state.follow_camera) {
      view_state.follow_camera = false;
      render_step_buttons();
    }
    if (view_state.mode === "mission" && mission.follow_camera) {
      mission.follow_camera = false;
      btn_phase_view_el.classList.add("attention");
    }
  });
}

// ---------------------------------------------------------------
// キーボード：← → で手順を移動、Esc で選択の解除・写真を閉じる
// ---------------------------------------------------------------
function setup_keyboard() {
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
    button.addEventListener("click", () => set_drive_move(button.dataset.move, true));
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
  controls.update(dt);
  update_tooltip();
  renderer.render(scene, camera);
}

// =============================================================
// はじめに実行する処理
// =============================================================
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

  setup_controls();
  setup_pointer_events();
  setup_keyboard();
  set_mode(view_state.mode);

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
