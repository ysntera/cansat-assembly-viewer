# XIAO ESP32S3 Sense（カメラ付きマイコン）の簡易モデルを STL で書き出す
# 座標は「組み上がった機体の CAD 座標（mm、z が上、-y が前）」で直接作る
# （placements.json では回転なし・移動なしで置く）
import math
import struct
import sys

# ===== カメラ基板（CameraBoard）の前の面：組み上がった位置から計算した値 =====
BOARD_FRONT_Y = -43.47      # 緑の基板の部品面（ピンソケットの先端）
BOARD_CENTER_X = 2.1        # 緑の基板の左右の中心
BOARD_TOP_Z = 29.33         # 緑の基板の上の端

# ===== XIAO ESP32S3 Sense の寸法（mm） =====
XIAO_LONG = 21.0            # 長い辺（公式）→ 縦に置く
XIAO_SHORT = 17.8           # 短い辺（公式）→ 横に置く
TOTAL_THICKNESS = 15.0      # 拡張基板込みの厚み（公式）
MAIN_THICKNESS = 4.0        # 本体基板＋部品（目安）
SENSE_THICKNESS = 3.5       # 拡張基板（目安）
CAMERA_SIZE = 9.0           # カメラの四角い部分（写真から）
CAMERA_THICKNESS = 4.5      # カメラの四角い部分の厚み（目安）
LENS_DIAMETER = 6.0         # レンズの直径（写真から）
LENS_LENGTH = TOTAL_THICKNESS - MAIN_THICKNESS - SENSE_THICKNESS - CAMERA_THICKNESS
CAMERA_OVERHANG = 2.7       # カメラが基板の端からはみ出す長さ（写真から）
TOP_MARGIN = 0.6            # カメラの上の端と緑の基板の上の端のすき間
LENS_SEGMENTS = 32


def box_triangles(x0, x1, y0, y1, z0, z1):
    """直方体の12枚の三角形を返す"""
    lo_x, hi_x = sorted((x0, x1))
    lo_y, hi_y = sorted((y0, y1))
    lo_z, hi_z = sorted((z0, z1))
    p = [(x, y, z) for x in (lo_x, hi_x) for y in (lo_y, hi_y) for z in (lo_z, hi_z)]
    # 頂点番号：x が 4 の位、y が 2 の位、z が 1 の位
    faces = [
        (0, 1, 3, 2), (4, 6, 7, 5),   # -x, +x
        (0, 4, 5, 1), (2, 3, 7, 6),   # -y, +y
        (0, 2, 6, 4), (1, 5, 7, 3),   # -z, +z
    ]
    tris = []
    for a, b, c, d in faces:
        tris.append((p[a], p[b], p[c]))
        tris.append((p[a], p[c], p[d]))
    return tris


def cylinder_y_triangles(cx, cz, y0, y1, radius, segments):
    """y 方向に伸びる円柱の三角形を返す"""
    tris = []
    for i in range(segments):
        a0 = 2 * math.pi * i / segments
        a1 = 2 * math.pi * (i + 1) / segments
        p0 = (cx + radius * math.cos(a0), cz + radius * math.sin(a0))
        p1 = (cx + radius * math.cos(a1), cz + radius * math.sin(a1))
        b0, b1 = (p0[0], y0, p0[1]), (p1[0], y0, p1[1])
        t0, t1 = (p0[0], y1, p0[1]), (p1[0], y1, p1[1])
        tris += [(b0, t0, t1), (b0, t1, b1)]                 # 側面
        tris.append(((cx, y0, cz), b1, b0))                  # 根元のふた
        tris.append(((cx, y1, cz), t0, t1))                  # 先のふた
    return tris


def normal_of(tri):
    (ax, ay, az), (bx, by, bz), (cx, cy, cz) = tri
    ux, uy, uz = bx - ax, by - ay, bz - az
    vx, vy, vz = cx - ax, cy - ay, cz - az
    nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
    length = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
    return nx / length, ny / length, nz / length


def write_binary_stl(path, tris):
    with open(path, "wb") as f:
        f.write(b"XIAO ESP32S3 Sense simple model".ljust(80, b" "))
        f.write(struct.pack("<I", len(tris)))
        for tri in tris:
            f.write(struct.pack("<3f", *normal_of(tri)))
            for v in tri:
                f.write(struct.pack("<3f", *v))
            f.write(struct.pack("<H", 0))


def main():
    if len(sys.argv) != 2:
        print("使い方: py make_xiao_camera_stl.py 出力先.stl")
        sys.exit(1)

    # 縦の位置：カメラの上の端を緑の基板の上の端より少し下にそろえる
    camera_top = BOARD_TOP_Z - TOP_MARGIN
    board_top = camera_top - CAMERA_OVERHANG
    board_bottom = board_top - XIAO_LONG
    x_left = BOARD_CENTER_X - XIAO_SHORT / 2
    x_right = BOARD_CENTER_X + XIAO_SHORT / 2

    # 前（-y）へ順に積み重ねる
    y_main = BOARD_FRONT_Y - MAIN_THICKNESS
    y_sense = y_main - SENSE_THICKNESS
    y_camera = y_sense - CAMERA_THICKNESS
    y_lens = y_camera - LENS_LENGTH

    camera_bottom = camera_top - CAMERA_SIZE
    camera_center_z = (camera_top + camera_bottom) / 2

    tris = []
    tris += box_triangles(x_left, x_right, BOARD_FRONT_Y, y_main, board_bottom, board_top)   # 本体基板
    tris += box_triangles(x_left, x_right, y_main, y_sense, board_bottom, board_top)         # 拡張基板
    tris += box_triangles(BOARD_CENTER_X - CAMERA_SIZE / 2, BOARD_CENTER_X + CAMERA_SIZE / 2,
                          y_sense, y_camera, camera_bottom, camera_top)                       # カメラ
    tris += cylinder_y_triangles(BOARD_CENTER_X, camera_center_z, y_camera, y_lens,
                                 LENS_DIAMETER / 2, LENS_SEGMENTS)                            # レンズ
    write_binary_stl(sys.argv[1], tris)
    print(f"三角形 {len(tris)} 枚 / 基板 z {board_bottom:.1f}〜{board_top:.1f} / レンズの先 y {y_lens:.1f}")


if __name__ == "__main__":
    main()
