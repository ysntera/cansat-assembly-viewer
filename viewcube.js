// =============================================================
// ViewCube（視点を切り替える立方体）
//   3D画面の右上に小さな立方体を描き、それで視点を操作できるようにする。
//   ・立方体は、メインのカメラと同じ向きから見て描く（今どちらから見ているかが分かる）
//   ・面をクリック → その向きから見た視点へ。辺・角をクリック → 斜めから見た視点へ
//   ・立方体をドラッグ → メインの画面も一緒に回る
//   ・⌂ ボタン → おすすめの視点に戻る（何をするかは main.js から on_home で受け取る）
//
// 座標：Three.js の座標（y が上）で考える。CAD の座標とは (x, y, z) → (x, z, −y) の関係
//   前（CAD の −y）＝ +z、上（CAD の +z）＝ +y、
//   左（CAD の +x。機体から見て左）＝ +x、右（CAD の −x）＝ −x
// =============================================================
import * as THREE from "three";

// ----- 見た目の定数 -----
const CUBE_HALF = 1;                   // 立方体の半分の大きさ（Three.js の単位。−1〜+1）
const CUBE_CAMERA_DISTANCE = 6;        // 立方体を見るカメラの、立方体の中心からの距離
const CUBE_CAMERA_FOV_DEG = 30;        // 立方体を見るカメラの画角
const LABEL_TEXTURE_SIZE = 128;        // 面の文字を描く画像の大きさ（ピクセル）
const FACE_COLOR = "#123250";          // 面の色（ロゴの紺）
const FACE_TEXT_COLOR = "#ffffff";     // 面の文字の色
const FACE_BORDER_COLOR = "#e5bd66";   // 面のふちの色（ロゴの金）
const HOVER_TINT = 0xffe2a0;           // マウスを乗せた面の色合い（金がかった色）
const EDGE_COLOR = 0xe5bd66;           // 立方体の辺の線の色

// ----- 操作の定数 -----
const EDGE_ZONE = 0.55;                // 面の中心からこの割合より外側を押すと「辺・角」とみなす（0〜1）
const DRAG_START_PX = 4;               // これ以上動かしたら「ドラッグ」とみなす（クリックと区別する）
const DRAG_RADIANS_PER_PX = 0.01;      // ドラッグ1ピクセルあたりに回す角度
const MIN_POLAR_RAD = 0.01;            // 真上・真下ちょうどにならないようにする（向きが決まらなくなるため）
const SNAP_DURATION_S = 0.6;           // 面を押したときに視点が回るのにかける時間
const TOP_VIEW_NUDGE = 0.001;          // 真上・真下から見るとき、前側へわずかにずらす（画面の上が「後ろ」になるように）

// 面の名前（BoxGeometry の面の順番：+x, −x, +y, −y, +z, −z）
const FACE_LABELS = ["左", "右", "上", "下", "前", "後ろ"];

// ---------------------------------------------------------------
// 面に貼る画像（紺の地に白い文字、ふちは金）を作る
// ---------------------------------------------------------------
function make_face_material(label) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = LABEL_TEXTURE_SIZE;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = FACE_COLOR;
  ctx.fillRect(0, 0, LABEL_TEXTURE_SIZE, LABEL_TEXTURE_SIZE);
  ctx.strokeStyle = FACE_BORDER_COLOR;
  ctx.lineWidth = LABEL_TEXTURE_SIZE * 0.05;
  ctx.strokeRect(0, 0, LABEL_TEXTURE_SIZE, LABEL_TEXTURE_SIZE);
  ctx.fillStyle = FACE_TEXT_COLOR;
  // 文字数に合わせて大きさを変える（「後ろ」は2文字）
  const font_size = LABEL_TEXTURE_SIZE * (label.length > 1 ? 0.34 : 0.46);
  ctx.font = `bold ${font_size}px "Noto Sans JP", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, LABEL_TEXTURE_SIZE / 2, LABEL_TEXTURE_SIZE / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshBasicMaterial({ map: texture });
}

// ---------------------------------------------------------------
// 立方体の上の、押した点（−1〜+1）から「見る向き」を決める。
//   面の中心のほうなら、その面の向き（例：上の面 → (0, 1, 0)）。
//   ふちのほうなら、となりの面の向きも足す（辺 → 2つの向き、角 → 3つの向きの斜め）
// ---------------------------------------------------------------
function view_direction_from_point(point) {
  const direction = new THREE.Vector3();
  for (const axis of ["x", "y", "z"]) {
    const value = point[axis] / CUBE_HALF;
    if (Math.abs(value) > 0.999) direction[axis] = Math.sign(value);              // 押した面そのもの
    else if (Math.abs(value) > EDGE_ZONE) direction[axis] = Math.sign(value);     // ふちに近い → となりの面
  }
  return direction.normalize();
}

// ---------------------------------------------------------------
// ViewCube を作る
//   main_camera / controls：メインの画面のカメラと、マウスで回す仕組み（OrbitControls）
//   container：立方体を描く場所（HTML の要素）
//   on_view_change：自分で視点を変えたときに呼ぶ（「おすすめの視点」への自動の移動を止めるため）
//   on_home：⌂ ボタンを押したときに呼ぶ
//   返す値：毎コマ呼ぶ update(dt) を持つもの
// ---------------------------------------------------------------
export function create_view_cube({ main_camera, controls, container, home_button, on_view_change, on_home }) {
  const canvas = document.createElement("canvas");
  canvas.className = "view_cube_canvas";
  canvas.setAttribute("aria-label", "視点を切り替える立方体。面を押すとその向きから見る。ドラッグで回す");
  container.appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const scene = new THREE.Scene();
  const cube_camera = new THREE.PerspectiveCamera(CUBE_CAMERA_FOV_DEG, 1, 0.1, 100);

  // 立方体と、辺の金の線
  const materials = FACE_LABELS.map(make_face_material);
  const cube = new THREE.Mesh(new THREE.BoxGeometry(CUBE_HALF * 2, CUBE_HALF * 2, CUBE_HALF * 2), materials);
  scene.add(cube);
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(cube.geometry),
    new THREE.LineBasicMaterial({ color: EDGE_COLOR }),
  );
  scene.add(edges);

  // ----- 押した場所を調べる（レイキャスト：画面の点から光線を飛ばして、当たったものを探す） -----
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  function pick(event) {
    const rect = canvas.getBoundingClientRect();
    pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, cube_camera);
    const hit = raycaster.intersectObject(cube)[0];
    return hit ?? null;
  }

  // マウスを乗せた面を、金がかった色にする
  let hovered_face = -1;
  function set_hovered_face(index) {
    if (index === hovered_face) return;
    if (hovered_face >= 0) materials[hovered_face].color.set(0xffffff);
    hovered_face = index;
    if (hovered_face >= 0) materials[hovered_face].color.set(HOVER_TINT);
    canvas.style.cursor = hovered_face >= 0 ? "pointer" : "grab";
  }

  // ----- メインのカメラを、注視点のまわりで回す -----
  const offset = new THREE.Vector3();
  const spherical = new THREE.Spherical();

  function rotate_main_camera(delta_x_px, delta_y_px) {
    offset.copy(main_camera.position).sub(controls.target);
    spherical.setFromVector3(offset);
    spherical.theta -= delta_x_px * DRAG_RADIANS_PER_PX;
    spherical.phi = THREE.MathUtils.clamp(
      spherical.phi - delta_y_px * DRAG_RADIANS_PER_PX, MIN_POLAR_RAD, Math.PI - MIN_POLAR_RAD);
    offset.setFromSpherical(spherical);
    main_camera.position.copy(controls.target).add(offset);
    main_camera.lookAt(controls.target);
  }

  // ----- 面・辺・角を押したとき：その向きから見た視点へ、なめらかに回す -----
  let snap = null;   // 回している途中なら { from, to, elapsed }（どちらも注視点からの向き）

  function snap_to(direction) {
    const to = direction.clone();
    // 真上・真下から見るときは、前側へわずかにずらす（画面の上が「後ろ」、下が「前」になる）
    if (Math.abs(to.y) > 0.999) to.z += TOP_VIEW_NUDGE;
    to.normalize();
    const from = main_camera.position.clone().sub(controls.target).normalize();
    snap = { from, to, elapsed: 0 };
  }

  function update_snap(dt) {
    if (!snap) return;
    snap.elapsed += dt;
    const t = Math.min(snap.elapsed / SNAP_DURATION_S, 1);
    const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;   // はじめと終わりをゆっくり
    // 向きを少しずつ変える（ちょうど反対向きのときは、まっすぐ混ぜると向きが決まらないので、横を通る）
    const direction = snap.from.clone().lerp(snap.to, eased);
    if (direction.lengthSq() < 1e-6) direction.set(1, 0, 0);
    direction.normalize();
    // 注視点からの距離は今のまま（機体が動いていても、注視点について回る）
    const distance = main_camera.position.distanceTo(controls.target);
    main_camera.position.copy(controls.target).addScaledVector(direction, distance);
    main_camera.lookAt(controls.target);
    if (t >= 1) snap = null;
  }

  // ----- マウス・指の操作 -----
  let drag = null;   // 押している間：{ x, y, moved }

  canvas.addEventListener("pointerdown", (event) => {
    canvas.setPointerCapture(event.pointerId);
    drag = { x: event.clientX, y: event.clientY, moved: false };
    event.preventDefault();
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!drag) {
      const hit = pick(event);
      set_hovered_face(hit ? hit.face.materialIndex : -1);
      return;
    }
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_START_PX) return;
    if (!drag.moved) {
      drag.moved = true;
      snap = null;
      on_view_change();
      canvas.style.cursor = "grabbing";
    }
    rotate_main_camera(dx, dy);
    drag.x = event.clientX;
    drag.y = event.clientY;
  });

  canvas.addEventListener("pointerup", (event) => {
    if (drag && !drag.moved) {
      // ドラッグしていなければクリック：押した場所の向きから見る
      const hit = pick(event);
      if (hit) {
        on_view_change();
        snap_to(view_direction_from_point(cube.worldToLocal(hit.point.clone())));
      }
    }
    drag = null;
    canvas.style.cursor = hovered_face >= 0 ? "pointer" : "grab";
  });

  canvas.addEventListener("pointerleave", () => {
    if (!drag) set_hovered_face(-1);
  });

  // ⌂ ボタン：おすすめの視点に戻る
  home_button.addEventListener("click", () => {
    snap = null;
    on_home();
  });

  // メインの画面で自分で回し始めたら、立方体による回転は止める
  controls.addEventListener("start", () => { snap = null; });

  // ----- 毎コマ：立方体を、メインのカメラと同じ向きから描く -----
  let last_size = 0;

  function update(dt) {
    update_snap(dt);

    const size = container.clientWidth;
    if (size !== last_size && size > 0) {
      renderer.setSize(size, size, false);
      last_size = size;
    }
    offset.copy(main_camera.position).sub(controls.target);
    if (offset.lengthSq() < 1e-9) return;
    cube_camera.position.copy(offset.normalize().multiplyScalar(CUBE_CAMERA_DISTANCE));
    cube_camera.up.copy(main_camera.up);
    cube_camera.lookAt(0, 0, 0);
    renderer.render(scene, cube_camera);
  }

  // 立方体で視点を回している途中か（main.js で、自動の視点の移動とぶつからないようにするため）
  function is_moving() {
    return snap !== null || (drag !== null && drag.moved);
  }

  return { update, is_moving };
}
