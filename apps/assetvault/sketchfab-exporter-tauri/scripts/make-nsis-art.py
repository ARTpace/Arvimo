#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""生成 NSIS 安装界面的「收纳箱」主题素材（可复现）。

产物（写入 src-tauri/nsis/）：
  sidebar.bmp       164x314  欢迎页 / 完成页左侧插图
  header.bmp        150x57   内页右上角小横条
  splash.bmp        380x150  安装开始时淡入淡出的启动小卡
  installer.ico              安装向导图标（MUI_ICON / MUI_UNICON）
  btn-primary.bmp           胶囊按钮：主色（开始安装）
  btn-mint.bmp              胶囊按钮：薄荷（打开 AssetVault）
  btn-soft.bmp              胶囊按钮：素色（完成）
  btn-*@2x.bmp              同上，1.5 倍（高 DPI 用）

主题：AssetVault 是一只把 3D 资产收进箱子的收纳箱。
用法：python scripts/make-nsis-art.py [--preview 目录]
"""
import math
import os
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
NSIS_DIR = os.path.join(HERE, '..', 'src-tauri', 'nsis')

# ---- 配色：奶油底 + 蜂蜜箱体 + 薄荷/珊瑚点缀 ----
CREAM = (255, 250, 241)
CREAM_D = (255, 240, 222)
BUTTER = (255, 214, 150)
AMBER = (246, 176, 88)
AMBER_D = (226, 148, 62)
LID = (255, 199, 122)
MINT = (126, 208, 174)
MINT_D = (86, 184, 148)
LIME = (206, 232, 162)
CORAL = (255, 150, 140)
SKY = (140, 199, 238)
INK = (90, 69, 53)
INK_SOFT = (156, 133, 113)
WHITE = (255, 255, 255)

SS = 4  # 超采样倍数


def font(size, bold=True):
    names = ('msyhbd.ttc', 'msyh.ttc') if bold else ('msyh.ttc', 'msyhbd.ttc')
    for name in names:
        path = os.path.join(os.environ.get('WINDIR', r'C:\Windows'), 'Fonts', name)
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                pass
    return ImageFont.load_default()


def vgradient(size, top, bottom):
    w, h = size
    img = Image.new('RGB', (1, max(1, h)))
    px = img.load()
    for y in range(h):
        t = y / max(1, h - 1)
        px[0, y] = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    return img.resize((w, h), Image.NEAREST)


def rounded_mask(size, radius, ss=SS):
    m = Image.new('L', (size[0] * ss, size[1] * ss), 0)
    ImageDraw.Draw(m).rounded_rectangle(
        (0, 0, size[0] * ss - 1, size[1] * ss - 1), radius=radius * ss, fill=255)
    return m.resize(size, Image.LANCZOS)


def blend(img, draw_fn):
    """半透明绘制要走独立图层：ImageDraw 直接在 RGBA 图上画带 alpha 的颜色是覆盖不是混合。"""
    layer = Image.new('RGBA', img.size, (0, 0, 0, 0))
    draw_fn(ImageDraw.Draw(layer))
    img.alpha_composite(layer)


def sparkle(draw, cx, cy, r, color):
    draw.polygon([(cx, cy - r), (cx + r * .28, cy - r * .28), (cx + r, cy),
                  (cx + r * .28, cy + r * .28), (cx, cy + r),
                  (cx - r * .28, cy + r * .28), (cx - r, cy),
                  (cx - r * .28, cy - r * .28)], fill=color)


def soft_ball(size, color, hi=0.30):
    """带高光的小球。"""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse((0, 0, size - 1, size - 1), fill=color + (255,))
    d.ellipse((size * .18, size * .14, size * .52, size * .46), fill=WHITE + (110,))
    return img


def soft_cube(size, color, dark):
    """带高光的小方块（可旋转）。"""
    img = vgradient((size, size), color, dark).convert('RGBA')
    img.putalpha(rounded_mask((size, size), int(size * .22)))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((size * .16, size * .10, size * .46, size * .34),
                        radius=int(size * .10), fill=WHITE + (86,))
    return img


def draw_box(img, cx, cy, size, lid_scale=.92):
    """画一只「收纳箱」：箱体 + 斜靠的箱盖 + 冒出来的资产小物 + 箱体标签。"""
    s = size * SS
    L = s * 3
    layer = Image.new('RGBA', (L, L), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    o = L // 2

    body_w, body_h = s * .86, s * .60
    body_top = o - s * .20
    body_left = o - body_w / 2
    body_bottom = body_top + body_h

    # 落地软影
    d.ellipse((o - body_w * .52, body_bottom - s * .04, o + body_w * .52, body_bottom + s * .13),
              fill=(196, 158, 116, 70))

    # 箱体
    body = vgradient((int(body_w), int(body_h)), BUTTER, AMBER).convert('RGBA')
    body.putalpha(rounded_mask((int(body_w), int(body_h)), int(s * .13)))
    layer.paste(body, (int(body_left), int(body_top)), body)

    # 箱口（内部暗色椭圆）
    mouth_h = s * .17
    d.ellipse((body_left + s * .035, body_top - mouth_h / 2, body_left + body_w - s * .035,
               body_top + mouth_h / 2), fill=AMBER_D + (255,))

    # 冒出来的资产小物
    cube = soft_cube(int(s * .26), MINT, MINT_D).rotate(-14, expand=True, resample=Image.BICUBIC)
    layer.paste(cube, (int(o - s * .30), int(body_top - s * .24)), cube)
    ball = soft_ball(int(s * .20), CORAL)
    layer.paste(ball, (int(o + s * .01), int(body_top - s * .19)), ball)
    ball2 = soft_ball(int(s * .13), SKY)
    layer.paste(ball2, (int(o + s * .22), int(body_top - s * .13)), ball2)

    # 箱口前沿（压住小物底部）
    d.arc((body_left + s * .035, body_top - mouth_h / 2, body_left + body_w - s * .035,
           body_top + mouth_h / 2), start=8, end=172, fill=AMBER_D + (255,),
          width=max(1, int(s * .022)))

    # 箱盖：斜靠在右侧
    lid_w, lid_h = body_w * lid_scale, s * .17
    lid = Image.new('RGBA', (int(lid_w) + int(s * .2), int(lid_h) + int(s * .3)), (0, 0, 0, 0))
    ld = ImageDraw.Draw(lid)
    lx, ly = s * .10, s * .14
    slab = vgradient((int(lid_w), int(lid_h)), (255, 224, 172), LID).convert('RGBA')
    slab.putalpha(rounded_mask((int(lid_w), int(lid_h)), int(s * .07)))
    lid.paste(slab, (int(lx), int(ly)), slab)
    ld.rounded_rectangle((lx + lid_w * .34, ly - s * .075, lx + lid_w * .66, ly + s * .03),
                         radius=int(s * .045), fill=MINT_D + (255,))
    ld.rounded_rectangle((lx + lid_w * .34 + s * .03, ly - s * .062,
                          lx + lid_w * .66 - s * .03, ly - s * .005),
                         radius=int(s * .025), fill=MINT + (255,))
    lid = lid.rotate(-13, expand=True, resample=Image.BICUBIC)
    layer.paste(lid, (int(o - lid.width / 2 + s * .05), int(body_top - lid.height * .66)), lid)

    # 表情
    ey = o + s * .04
    for sx in (-1, 1):
        ex = o + sx * body_w * .17
        d.ellipse((ex - s * .085, ey - s * .085, ex + s * .085, ey + s * .085), fill=WHITE + (255,))
        d.ellipse((ex - s * .050, ey - s * .040, ex + s * .050, ey + s * .060), fill=INK + (255,))
        d.ellipse((ex - s * .034, ey - s * .020, ex - s * .006, ey + s * .014), fill=WHITE + (255,))
    for sx in (-1, 1):
        ex = o + sx * body_w * .33
        d.ellipse((ex - s * .062, ey + s * .085, ex + s * .062, ey + s * .163), fill=CORAL + (120,))
    d.arc((o - s * .062, ey + s * .055, o + s * .062, ey + s * .145), start=20, end=160,
          fill=INK + (255,), width=max(1, int(s * .020)))

    # 箱体标签
    tag_w, tag_h = body_w * .40, s * .105
    tag = Image.new('RGBA', (int(tag_w), int(tag_h)), (0, 0, 0, 0))
    td = ImageDraw.Draw(tag)
    td.rounded_rectangle((0, 0, tag_w - 1, tag_h - 1), radius=int(tag_h * .42),
                         fill=(255, 253, 246, 235))
    td.rounded_rectangle((tag_w * .14, tag_h * .38, tag_w * .62, tag_h * .60),
                         radius=int(tag_h * .11), fill=MINT_D + (215,))
    tag = tag.rotate(-5, expand=True, resample=Image.BICUBIC)
    layer.paste(tag, (int(o - tag.width / 2), int(body_bottom - tag_h * 1.45)), tag)

    layer = layer.resize((L // SS, L // SS), Image.LANCZOS)
    img.paste(layer, (int(cx - L / SS / 2), int(cy - L / SS / 2)), layer)


def make_sidebar():
    w, h = 164, 314
    img = vgradient((w, h), (255, 251, 243), (238, 249, 241)).convert('RGBA')

    def deco(d):
        d.ellipse((16, 28, 38, 50), fill=LIME + (225,))
        d.ellipse((124, 66, 140, 82), fill=SKY + (215,))
        d.ellipse((18, 174, 30, 186), fill=CORAL + (205,))
        sparkle(d, 132, 28, 9, LIME + (255,))
        sparkle(d, 26, 130, 7, WHITE + (235,))
        sparkle(d, 136, 164, 6, SKY + (230,))
    blend(img, deco)

    draw_box(img, w / 2, 122, 76)

    def hill(top_y, amp, color):
        def draw(d):
            pts = [(x, top_y - amp * math.sin(math.pi * x / w)) for x in range(w + 1)]
            d.polygon(pts + [(w, h), (0, h)], fill=color)
        blend(img, draw)

    hill(226, 11, MINT_D + (255,))
    hill(238, 11, (255, 255, 255, 26))

    d = ImageDraw.Draw(img)
    f_big, f_small = font(25, True), font(11, False)
    title, sub = 'AssetVault', '把 3D 资产收进箱子'
    d.text(((w - d.textlength(title, font=f_big)) / 2, 236), title, font=f_big, fill=WHITE)
    d.text(((w - d.textlength(sub, font=f_small)) / 2, 271), sub, font=f_small, fill=(233, 251, 242))
    return img.convert('RGB')


def make_header():
    w, h = 150, 57
    img = vgradient((w, h), (255, 252, 246), (243, 250, 244)).convert('RGBA')

    def deco(d):
        d.ellipse((100, -32, 184, 52), fill=BUTTER + (120,))
        d.ellipse((-28, 30, 42, 100), fill=LIME + (70,))
        sparkle(d, 139, 12, 6, WHITE + (235,))
    blend(img, deco)

    draw_box(img, 30, 30, 30)

    d = ImageDraw.Draw(img)
    d.text((56, 11), 'AssetVault', font=font(16, True), fill=INK)
    d.text((57, 33), '把资产收进箱子', font=font(9, False), fill=INK_SOFT)
    return img.convert('RGB')


def make_splash():
    w, h = 380, 150
    img = vgradient((w, h), (255, 251, 243), (240, 250, 244)).convert('RGBA')

    def deco(d):
        d.rounded_rectangle((4, 4, w - 5, h - 5), radius=24, outline=AMBER + (210,), width=2)
        d.ellipse((-56, 52, 96, 204), fill=BUTTER + (95,))
        d.ellipse((252, -62, 432, 118), fill=MINT + (72,))
        sparkle(d, 326, 32, 10, WHITE + (235,))
        sparkle(d, 40, 118, 7, CORAL + (205,))
    blend(img, deco)

    draw_box(img, 78, 74, 72)

    d = ImageDraw.Draw(img)
    d.text((156, 44), 'AssetVault 正在安家', font=font(19, True), fill=INK)
    d.text((158, 76), '正在把模型、材质和天空盒收进箱子～', font=font(11, False), fill=INK_SOFT)
    return img.convert('RGB')


def pill(size, text, bg, fg, border=None):
    """圆角胶囊按键：平涂 + 极淡落影 + 同色系细描边，和手绘面板是同一套笔触。

    旧版给了一圈厚投影 + 高光带（玻璃质感），跟扁平的插画严重不搭，故改回平涂。
    """
    w, h = size
    img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = (h - 2) / 2
    ow = max(1, int(round(h * 0.05)))
    # 只在下沿留 2px 落影，够托起按键又不抢戏
    d.rounded_rectangle((0, 2, w - 1, h - 1), radius=r, fill=(160, 120, 80, 36))
    body = (0, 0, w - 1, h - 3)
    d.rounded_rectangle(body, radius=r, fill=bg + (255,))
    if border:
        d.rounded_rectangle(body, radius=r, outline=border + (255,), width=ow)
    # ⚠️ 这里不能加「半透明白高光」：ImageDraw 在 RGBA 图上 fill=(255,255,255,30)
    # 是直接覆盖像素而不是叠加，会把底下的琥珀整块删掉、只剩一层 12% 的白；
    # 再经 bake()/to_bmp() 合成后基本等于面板底色 —— 表现出来就是按钮上部被
    # 「挖掉一条白杠」（用户截图里那条「很大的白边」）。真要加高光，必须先画到
    # 独立图层再 alpha_composite。这里保持纯平涂，和扁平手绘插画也更搭。
    f = font(int(h * .38), True)
    d.text((w / 2, (h - 3) / 2), text, font=f, fill=fg, anchor='mm')
    return img


def to_bmp(img, bg=(241, 251, 244)):
    # 底色取整窗面板渐变中下段的实际颜色（胶囊按键都落在这条带子上），
    # 这样按钮圆角外的空白与背景几乎无色差，不会看出一个方框。
    """BMP 没有 alpha：必须把透明区合成到底色上，否则 convert('RGB') 会留下黑块。

    （胶囊按键的圆角外全是透明像素，走 convert('RGB') 会整块变黑，这正是
      「按键风格和画面不匹配」的根因。）
    """
    if img.mode == 'RGB':
        return img
    flat = Image.new('RGB', img.size, bg)
    flat.paste(img, (0, 0), img)
    return flat


def bake(img, panel_name, bx, by, scale):
    """把带 alpha 的按键合成到面板对应位置的裁片上，输出无 alpha 的 BMP。

    比“填一个近似底色”强得多：按键圆角外就是面板本身的像素，
    压在插画或渐变上都看不出方框。
    """
    path = os.path.join(NSIS_DIR, panel_name + '.bmp')
    w, h = img.size
    if not os.path.exists(path):
        return to_bmp(img)
    panel = Image.open(path).convert('RGB')
    x = max(0, min(int(round(bx * scale)), panel.width - w))
    y = max(0, min(int(round(by * scale)), panel.height - h))
    region = panel.crop((x, y, x + w, y + h))
    region.paste(img, (0, 0), img)
    return region


def close_button(size, scale=1.0):
    """右上角的关闭圆钮 —— 无标题栏窗口唯一的关闭入口。"""
    w, h = size
    img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    m = max(1, int(round(1.5 * scale)))
    d.ellipse((m, m, w - 1 - m, h - 1 - m), fill=(250, 240, 226, 255),
              outline=(226, 208, 184, 255), width=max(1, int(round(1.2 * scale))))
    c = w / 2.0
    r = w * 0.21
    lw = max(2, int(round(1.9 * scale)))
    d.line((c - r, c - r, c + r, c + r), fill=INK_SOFT + (255,), width=lw)
    d.line((c - r, c + r, c + r, c - r), fill=INK_SOFT + (255,), width=lw)
    return img


def make_buttons(preview_dir):
    specs = [
        ('btn-primary', '开始安装', AMBER, WHITE, AMBER_D),
        ('btn-mint', '打开 AssetVault', MINT_D, WHITE, (66, 158, 126)),
        ('btn-soft', '完成', (250, 240, 226), INK, (226, 208, 184)),
    ]
    for name, text, bg, fg, border in specs:
        for scale, suffix in ((1.0, ''), (1.5, '@2x')):
            w, h = int(176 * scale), int(44 * scale)
            img = pill((w, h), text, bg, fg, border)
            out = os.path.join(NSIS_DIR, name + suffix + '.bmp')
            to_bmp(img).save(out)
            if preview_dir:
                img.save(os.path.join(preview_dir, name + suffix + '.png'))
            print('  %-20s %sx%s' % (name + suffix + '.bmp', w, h))


def make_panel(title, subtitle, base_w=480, base_h=283, scale=1.0):
    """自定义页面用的整页手绘面板（标题直接画在位图上，页面只叠加正文与胶囊按键）。"""
    w, h = int(base_w * scale), int(base_h * scale)
    px = lambda v: int(round(v * scale))
    img = vgradient((w, h), (255, 252, 246), (238, 250, 243)).convert('RGBA')

    def deco(d):
        d.rounded_rectangle((px(3), px(3), w - px(4), h - px(4)), radius=px(22),
                            outline=(255, 224, 178, 255), width=max(1, px(2)))
        d.ellipse((px(-70), px(120), px(110), px(300)), fill=BUTTER + (70,))
        d.ellipse((px(330), px(-70), px(560), px(160)), fill=MINT + (58,))
        sparkle(d, px(438), px(36), px(11), WHITE + (235,))
        sparkle(d, px(40), px(232), px(8), CORAL + (200,))
        sparkle(d, px(300), px(24), px(7), SKY + (190,))
    blend(img, deco)

    draw_box(img, px(92), px(126), px(138), lid_scale=.62)

    d = ImageDraw.Draw(img)
    d.text((px(206), px(52)), title, font=font(px(25), True), fill=INK)
    d.text((px(208), px(92)), subtitle, font=font(px(12), False), fill=INK_SOFT)
    return img


def make_panels(preview_dir):
    for name, title, sub in (
            ('panel-welcome', '欢迎使用 AssetVault', '把模型、材质和天空盒都收进箱子'),
            ('panel-finish', '都收好啦～', 'AssetVault 已经安好家，随时等你来用')):
        for scale, suffix in ((1.0, ''), (1.5, '@2x')):
            img = make_panel(title, sub, scale=scale)
            out = os.path.join(NSIS_DIR, name + suffix + '.bmp')
            to_bmp(img).save(out)
            if preview_dir:
                img.save(os.path.join(preview_dir, name + suffix + '.png'))
            print('  %-22s %sx%s' % (name + suffix + '.bmp', img.width, img.height))


WIN_W, WIN_H = 600, 380
WIN_R = 26   # 卡片圆角（逻辑像素）；NSIS 侧 CreateRoundRectRgn 要传 2*WIN_R


def window_panel(title, subtitle, scale=1.0, flat=False):
    """整窗面板（无边框安装器）：收纳箱插画在左、标题文案在右，右下留给胶囊按键。

    背景要裁成圆角并铺满整张图 —— 否则窗口圆角与画面圆角对不上，四角会露出底色。
    """
    w, h = int(WIN_W * scale), int(WIN_H * scale)
    px = lambda v: int(round(v * scale))
    if flat:
        # 与 MUI_INSTFILESPAGE_COLORS 的页面底色一致，避免出现色块边界
        base = Image.new('RGBA', (w, h), (255, 250, 242, 255))
    else:
        base = vgradient((w, h), (255, 252, 246), (236, 250, 242)).convert('RGBA')
    base.putalpha(rounded_mask((w, h), px(WIN_R)))
    img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    img.alpha_composite(base)

    def deco(d):
        d.rounded_rectangle((px(2), px(2), w - px(3), h - px(3)), radius=px(WIN_R - 2),
                            outline=(255, 214, 160, 255), width=max(1, px(2)))
        d.ellipse((px(392), px(-150), px(760), px(210)), fill=MINT + (48,))
        d.ellipse((px(-140), px(200), px(170), px(510)), fill=BUTTER + (68,))
        sparkle(d, px(552), px(44), px(12), WHITE + (240,))
        sparkle(d, px(60), px(326), px(9), CORAL + (205,))
        sparkle(d, px(392), px(26), px(8), SKY + (190,))
        sparkle(d, px(526), px(304), px(7), MINT_D + (160,))
    blend(img, deco)

    draw_box(img, px(158), px(186), px(178), lid_scale=.60)

    d = ImageDraw.Draw(img)
    d.text((px(296), px(106)), title, font=font(px(24), True), fill=INK)
    d.text((px(298), px(150)), subtitle, font=font(px(12), False), fill=INK_SOFT)

    # BMP 没有 alpha 通道，合成到实色底（裁掉的圆角正好被窗口圆角盖住）
    out = Image.new('RGB', (w, h), (255, 250, 242))
    out.paste(img, (0, 0), img)
    return out


def make_window_panels(preview_dir):
    specs = (
        ('win-welcome', '欢迎使用 AssetVault', '把模型、材质和天空盒统统收进箱子', False),
        ('win-folder', '选个安家的位置', '默认就行～ 想换的话点下面的按钮', False),
        ('win-install', '正在把资产收进箱子…', '别关掉我，马上就好～', True),
        ('win-finish', '都收好啦～', 'AssetVault 已经安好家，随时等你来用', False),
    )
    for name, title, sub, flat in specs:
        for scale, suffix in ((1.0, ''), (1.5, '@2x')):
            img = window_panel(title, sub, scale=scale, flat=flat)
            out = os.path.join(NSIS_DIR, name + suffix + '.bmp')
            to_bmp(img).save(out)
            if preview_dir:
                img.save(os.path.join(preview_dir, name + suffix + '.png'))
            print('  %-22s %sx%s' % (name + suffix + '.bmp', img.width, img.height))


def make_window_buttons(preview_dir):
    SOFT = ((250, 240, 226), INK, (226, 208, 184))
    # (文件名, 文案, 1x 尺寸, 底色, 字色, 描边, 所在面板, 1x 左上角)
    specs = [
        ('wbtn-start', '开始安装', (180, 46), AMBER, WHITE, AMBER_D, 'win-welcome', (210, 292)),
        ('wbtn-later', '暂时不要', (180, 46), SOFT[0], SOFT[1], SOFT[2], 'win-welcome', (402, 292)),
        ('wbtn-run', '打开 AssetVault', (180, 46), MINT_D, WHITE, (66, 158, 126), 'win-welcome', (210, 292)),
        ('wbtn-done', '完成', (180, 46), SOFT[0], SOFT[1], SOFT[2], 'win-welcome', (402, 292)),
        ('wbtn-back', '上一步', (180, 46), SOFT[0], SOFT[1], SOFT[2], 'win-welcome', (402, 292)),
        ('wbtn-folder', '换个位置', (150, 36), SOFT[0], SOFT[1], SOFT[2], 'win-welcome', (300, 226)),
        ('wbtn-cancel', '取消安装', (150, 36), SOFT[0], SOFT[1], SOFT[2], 'win-install', (424, 322)),
    ]
    for name, text, (bw, bh), bg, fg, border, panel, (bx, by) in specs:
        for scale, suffix in ((1.0, ''), (1.5, '@2x')):
            w, h = int(bw * scale), int(bh * scale)
            img = pill((w, h), text, bg, fg, border)
            out = os.path.join(NSIS_DIR, name + suffix + '.bmp')
            bake(img, panel + suffix, bx, by, scale).save(out)
            if preview_dir:
                img.save(os.path.join(preview_dir, name + suffix + '.png'))
            print('  %-20s %sx%s' % (name + suffix + '.bmp', w, h))
    # 右上角关闭圆钮：无标题栏窗口唯一的关闭入口，别省
    for scale, suffix in ((1.0, ''), (1.5, '@2x')):
        w = h = int(30 * scale)
        img = close_button((w, h), scale)
        out = os.path.join(NSIS_DIR, 'wbtn-close' + suffix + '.bmp')
        bake(img, 'win-welcome' + suffix, 540, 16, scale).save(out)
        if preview_dir:
            img.save(os.path.join(preview_dir, 'wbtn-close' + suffix + '.png'))
        print('  %-20s %sx%s' % ('wbtn-close' + suffix + '.bmp', w, h))


def make_icon(preview_dir):
    base = 256
    img = Image.new('RGBA', (base, base), (0, 0, 0, 0))
    bg = vgradient((base, base), (255, 252, 245), (233, 248, 238)).convert('RGBA')
    img.paste(bg, (0, 0), rounded_mask((base, base), 58, ss=2))
    draw_box(img, base / 2, base / 2 + 6, 190)
    img.save(os.path.join(NSIS_DIR, 'installer.ico'),
             sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    if preview_dir:
        img.save(os.path.join(preview_dir, 'installer.ico.png'))
    print('  installer.ico')


def save_bmp(img, name, preview_dir):
    out = os.path.join(NSIS_DIR, name)
    img.save(out)
    if preview_dir:
        img.save(os.path.join(preview_dir, os.path.splitext(name)[0] + '.png'))
    print('  %-14s %sx%s  %s bytes' % (name, img.width, img.height, os.path.getsize(out)))


def main():
    preview_dir = None
    if '--preview' in sys.argv:
        preview_dir = sys.argv[sys.argv.index('--preview') + 1]
        os.makedirs(preview_dir, exist_ok=True)
    os.makedirs(NSIS_DIR, exist_ok=True)
    print('生成安装界面素材 ->', os.path.abspath(NSIS_DIR))
    save_bmp(make_sidebar(), 'sidebar.bmp', preview_dir)
    save_bmp(make_header(), 'header.bmp', preview_dir)
    save_bmp(make_splash(), 'splash.bmp', preview_dir)
    make_buttons(preview_dir)
    make_panels(preview_dir)
    make_window_panels(preview_dir)
    make_window_buttons(preview_dir)
    make_icon(preview_dir)


if __name__ == '__main__':
    main()
