/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import open from 'open';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
  type ExecuteOptions,
} from './tools.js';
import type { Config } from '../config/config.js';
import { ToolErrorType } from './tool-error.js';
import { getErrorMessage } from '../utils/errors.js';
import { debugLogger } from '../utils/debugLogger.js';

export const CREATE_PPTX_TOOL_NAME = 'create_pptx';
export const CREATE_PPTX_DISPLAY_NAME = 'Create PowerPoint';

/** Default subdirectory (under the target dir) for generated decks. */
const DEFAULT_OUTPUT_DIR = 'openrnd-ppt';

/** PowerPoint launch + build can be slow; allow a generous default. */
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_TIMEOUT_MS = 600_000;

/** Logical layouts the model can request; mapped to template layouts at build time. */
export type CreatePptxLayout =
  | 'title'
  | 'section'
  | 'bullets'
  | 'two_col'
  | 'table'
  | 'image'
  | 'blank';

export interface CreatePptxSlide {
  /** Logical layout. Defaults to 'bullets'. */
  layout?: CreatePptxLayout;
  /**
   * How to realize this slide when a sample deck is provided:
   * - 'auto' (default): clone the sample slide whose layout best matches this
   *   slide and replace its text — preserves the sample's actual design (shapes,
   *   colors, fonts, positions), not just the theme.
   * - 'reuse': clone a specific sample slide (see sample_slide_index) and replace
   *   its text. Use this to pin an exact slide format.
   * - 'themed_new': compose a fresh slide using only the sample's theme/layout
   *   (no design from the sample's slides). Plainer; use when no sample slide fits.
   * Ignored when no sample is provided.
   */
  mode?: 'auto' | 'reuse' | 'themed_new';
  /** 1-based index of the sample slide to clone when mode === 'reuse'. */
  sample_slide_index?: number;
  title?: string;
  /** Subtitle / lead text (title & section layouts). */
  subtitle?: string;
  /** Bullet lines for the main body (or the left column of two_col). */
  bullets?: string[];
  /** Bullet lines for the right column of a two_col layout. */
  bullets_right?: string[];
  /** Table data as rows of cells; the first row is treated as the header. */
  table?: string[][];
  /** Absolute or workspace-relative path to an image to place on the slide. */
  image_path?: string;
  /** Presenter notes for this slide. */
  notes?: string;
}

export interface CreatePptxParams {
  /** Ordered slides to generate. At least one is required. */
  slides: CreatePptxSlide[];
  /**
   * Optional reference deck (.ppt/.pptx). Its slide master, layouts, theme
   * (fonts/colors), and slides are used as the style reference so the result
   * looks like the in-house deck. In-house DRM-protected samples are supported
   * because they are opened through PowerPoint (win32com), the DRM-allowed path.
   */
  sample_path?: string;
  /** Output .pptx path (absolute or workspace-relative). Defaults under openrnd-ppt/. */
  output_path?: string;
  /**
   * Visual style when NO sample is provided. 'consulting' (default) applies a
   * built-in consulting-style template (navy/accent palette, title rules, styled
   * bullets, section dividers, footer + page numbers). 'plain' uses PowerPoint's
   * default theme. Ignored when sample_path is set (the sample's design is used).
   */
  style?: 'consulting' | 'plain';
  /** Optional footer label shown on content slides (e.g. team / "Confidential"). */
  footer?: string;
  /** Open the generated deck in PowerPoint when done. Default: true. */
  open?: boolean;
  /** Max build time in seconds (default 180, max 600). */
  timeout_seconds?: number;
}

/** Turns a title-ish string into a filesystem-safe slug. */
function slugify(s: string): string {
  const cleaned = s
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'deck';
}

/** Compact local timestamp, e.g. 20260605-231500. */
function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function detectPythonExecutable(): string {
  return process.platform === 'win32' ? 'python' : 'python3';
}

/**
 * Python helper that builds a .pptx through the installed PowerPoint application
 * via win32com (pywin32). Driving PowerPoint directly is the only path the
 * in-house DRM agent allows, so a DRM-protected sample deck can be opened and
 * used as a style reference. The spec (slides + sample path) is read from a JSON
 * file (argv[1]); the deck is written to argv[2]. Diagnostics go to stderr; a
 * one-line JSON summary is printed to stdout on success.
 */
const PPTX_BUILD_SCRIPT = String.raw`# -*- coding: utf-8 -*-
import os
import sys
import json


def _utf8():
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def ensure_pywin32():
    try:
        import win32com.client  # noqa: F401
        return True
    except ImportError:
        pass
    import subprocess
    sys.stderr.write("PYWIN32_MISSING: installing pywin32 with %s\n" % sys.executable)
    try:
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "--user", "--upgrade", "pywin32"]
        )
    except Exception as exc:
        sys.stderr.write("PYWIN32_AUTO_INSTALL_FAILED: %s\n" % exc)
        return False
    try:
        import win32com.client  # noqa: F401
        return True
    except ImportError as exc:
        sys.stderr.write("PYWIN32_STILL_MISSING: %s\n" % exc)
        return False


# --- PowerPoint enums -------------------------------------------------------
ppLayoutTitle = 1
ppLayoutText = 2
ppLayoutTwoColumnText = 4
ppLayoutTitleOnly = 11
ppLayoutBlank = 12
ppPlaceholderTitle = 13
ppPlaceholderCenterTitle = 12
ppPlaceholderSubtitle = 4
ppPlaceholderBody = 2
ppPlaceholderObject = 7
msoTextOrientationHorizontal = 1
msoFalse = 0
msoTrue = -1
ppSaveAsOpenXMLPresentation = 24

WARN = []


def warn(msg):
    WARN.append(str(msg))


def _txt(v):
    return "" if v is None else str(v)


def set_text(shape, text, font=None):
    try:
        tr = shape.TextFrame.TextRange
        tr.Text = _txt(text)
        if font:
            try:
                tr.Font.NameFarEast = font
            except Exception:
                pass
    except Exception as exc:
        warn("set_text: %s" % exc)


def set_bullets(shape, items, font=None):
    try:
        lines = []
        levels = []
        for it in items:
            if isinstance(it, dict):
                lines.append(_txt(it.get("text")))
                levels.append(int(it.get("level", 0) or 0))
            else:
                lines.append(_txt(it))
                levels.append(0)
        tr = shape.TextFrame.TextRange
        tr.Text = "\r".join(lines)
        for idx, lvl in enumerate(levels, start=1):
            if lvl and lvl > 0:
                try:
                    tr.Paragraphs(idx, 1).IndentLevel = min(lvl + 1, 5)
                except Exception:
                    pass
        if font:
            try:
                tr.Font.NameFarEast = font
            except Exception:
                pass
    except Exception as exc:
        warn("set_bullets: %s" % exc)


def find_title(slide):
    try:
        return slide.Shapes.Title
    except Exception:
        pass
    try:
        for ph in slide.Shapes.Placeholders:
            try:
                if ph.PlaceholderFormat.Type in (ppPlaceholderTitle, ppPlaceholderCenterTitle):
                    return ph
            except Exception:
                pass
    except Exception:
        pass
    return None


def content_placeholders(slide):
    res = []
    title_id = None
    try:
        t = find_title(slide)
        if t is not None:
            title_id = t.Id
    except Exception:
        title_id = None
    try:
        for ph in slide.Shapes.Placeholders:
            try:
                if title_id is not None and ph.Id == title_id:
                    continue
                if ph.PlaceholderFormat.Type in (ppPlaceholderTitle, ppPlaceholderCenterTitle):
                    continue
                res.append(ph)
            except Exception:
                pass
    except Exception as exc:
        warn("content_placeholders: %s" % exc)
    return res


def _area(shp):
    try:
        return float(shp.Width) * float(shp.Height)
    except Exception:
        return 0.0


def _top(shp):
    try:
        return float(shp.Top)
    except Exception:
        return 0.0


def _slide_profile(slide):
    """Lightweight structural summary of a sample slide, used to match a content
    slide to the sample slide whose design best fits it."""
    n_text = 0
    has_table = False
    has_pic = False
    max_area = 0.0
    try:
        for shp in slide.Shapes:
            try:
                if shp.HasTable:
                    has_table = True
            except Exception:
                pass
            try:
                if shp.Type == 13:  # msoPicture
                    has_pic = True
            except Exception:
                pass
            try:
                if shp.HasTextFrame:
                    n_text += 1
                    a = _area(shp)
                    if a > max_area:
                        max_area = a
            except Exception:
                pass
    except Exception:
        pass
    return {"n_text": n_text, "has_table": has_table, "has_pic": has_pic, "max_area": max_area}


def build_sample_index(pres, orig_count):
    prof = {}
    for i in range(1, orig_count + 1):
        try:
            prof[i] = _slide_profile(pres.Slides.Item(i))
        except Exception:
            prof[i] = {"n_text": 0, "has_table": False, "has_pic": False, "max_area": 0.0}
    return prof


def pick_source_slide(pres, orig_count, logical, prof):
    """Choose which existing sample slide to clone for a requested content slide,
    so the clone carries the design that best fits. Order: layout-name hint ->
    structural match (table/image/columns/content) -> position fallback. The
    model can always override per slide via sample_slide_index."""
    if orig_count <= 0:
        return None

    # 1) layout name hint (e.g. "제목 슬라이드", "구역", "two content")
    hints = LAYOUT_NAME_HINTS.get(logical, [])
    for i in range(1, orig_count + 1):
        try:
            nm = (pres.Slides.Item(i).CustomLayout.Name or "").lower()
        except Exception:
            nm = ""
        for h in hints:
            if h.lower() in nm:
                return i

    prof = prof or {}

    # 2) structural match by the kind of content this slide carries
    if logical == "table":
        for i in range(1, orig_count + 1):
            if prof.get(i, {}).get("has_table"):
                return i
    if logical == "image":
        for i in range(1, orig_count + 1):
            if prof.get(i, {}).get("has_pic"):
                return i
    if logical == "two_col":
        best = None
        for i in range(2, orig_count + 1):
            if prof.get(i, {}).get("n_text", 0) >= 3:
                best = i
                break
        if best:
            return best
    if logical == "title":
        return 1
    if logical == "section":
        # a sparse slide (few text frames), not the cover
        for i in range(2, orig_count + 1):
            if 0 < prof.get(i, {}).get("n_text", 0) <= 2:
                return i

    # 3) default = a "content" slide: most body area, excluding the cover
    best_i = None
    best_area = -1.0
    for i in range(2, orig_count + 1):
        p = prof.get(i, {})
        if p.get("n_text", 0) >= 1 and p.get("max_area", 0.0) > best_area:
            best_area = p.get("max_area", 0.0)
            best_i = i
    if best_i:
        return best_i
    return 2 if orig_count >= 2 else 1


def text_frames(slide):
    """Every shape on the slide that can hold text (placeholder OR plain text
    box), whether or not it currently has text — these are the regions we fill
    with the new content while keeping the cloned slide's design."""
    res = []
    try:
        for shp in slide.Shapes:
            try:
                if shp.HasTextFrame:
                    res.append(shp)
            except Exception:
                pass
    except Exception:
        pass
    return res


def _shape_text_len(shp):
    try:
        if shp.TextFrame.HasText:
            return len(shp.TextFrame.TextRange.Text or "")
    except Exception:
        pass
    return 0


def fill_cloned(slide, spec, sw, sh):
    """Fill a slide cloned from a sample: keep its design but replace the text in
    its existing shapes with the NEW content, and blank out any leftover original
    body text so none of the sample's wording remains. Does NOT force a font — the
    cloned shapes keep their own formatting."""
    title = spec.get("title")
    subtitle = spec.get("subtitle")
    bullets = spec.get("bullets")
    bullets_right = spec.get("bullets_right")
    table = spec.get("table")
    image_path = spec.get("image_path")
    notes = spec.get("notes")

    frames = text_frames(slide)

    # Locate the title shape (placeholder if present, else the top-most frame),
    # and exclude exactly that one frame by index (robust to Id quirks on clones).
    title_idx = -1
    t = find_title(slide)
    if t is not None:
        try:
            tid = t.Id
            for i, f in enumerate(frames):
                try:
                    if f.Id == tid:
                        title_idx = i
                        break
                except Exception:
                    pass
        except Exception:
            pass
    if title_idx == -1 and frames:
        order = sorted(range(len(frames)), key=lambda i: _top(frames[i]))
        title_idx = order[0]

    # Body candidates = all non-title text frames, largest area first.
    body_frames = [f for i, f in enumerate(frames) if i != title_idx]
    body_frames.sort(key=_area, reverse=True)

    if title:
        if title_idx != -1:
            set_text(frames[title_idx], title, None)
        else:
            warn("cloned slide has no title shape; title not placed")

    consumed = 0
    if bullets:
        if body_frames:
            set_bullets(body_frames[0], bullets, None)
            consumed = 1
        else:
            warn("cloned slide has no body shape; bullets not placed")
    elif subtitle:
        if body_frames:
            set_text(body_frames[0], subtitle, None)
            consumed = 1

    if bullets_right and len(body_frames) > consumed:
        set_bullets(body_frames[consumed], bullets_right, None)
        consumed += 1

    # Clear leftover ORIGINAL text in remaining sizeable content regions so the
    # sample's wording doesn't linger. Small shapes (footers, page numbers,
    # labels) are left alone so the design's furniture survives.
    min_area = sw * sh * 0.04
    for f in body_frames[consumed:]:
        try:
            if _area(f) >= min_area and _shape_text_len(f) > 0:
                f.TextFrame.TextRange.Text = ""
        except Exception:
            pass

    if table:
        add_table(slide, table, sw * 0.06, sh * 0.55, sw * 0.88, sh * 0.4)
    if image_path:
        add_picture(slide, os.path.abspath(image_path), sw * 0.55, sh * 0.2, sw * 0.4, sh * 0.5)
    if notes:
        set_notes(slide, notes)


def add_table(slide, data, left, top, width, height):
    try:
        rows = len(data)
        cols = max((len(r) for r in data), default=0)
        if rows == 0 or cols == 0:
            return
        shp = slide.Shapes.AddTable(rows, cols, left, top, width, height)
        tbl = shp.Table
        for r in range(rows):
            for c in range(cols):
                val = data[r][c] if c < len(data[r]) else ""
                try:
                    tbl.Cell(r + 1, c + 1).Shape.TextFrame.TextRange.Text = _txt(val)
                except Exception:
                    pass
    except Exception as exc:
        warn("add_table: %s" % exc)


def add_picture(slide, img, left, top, width, height):
    try:
        if not os.path.exists(img):
            warn("image not found: %s" % img)
            return
        slide.Shapes.AddPicture(img, msoFalse, msoTrue, left, top, width, height)
    except Exception as exc:
        warn("add_picture: %s" % exc)


def set_notes(slide, text):
    try:
        slide.NotesPage.Shapes.Placeholders.Item(2).TextFrame.TextRange.Text = _txt(text)
    except Exception as exc:
        warn("set_notes: %s" % exc)


LOGICAL_TO_PPLAYOUT = {
    "title": ppLayoutTitle,
    "section": ppLayoutTitleOnly,
    "bullets": ppLayoutText,
    "two_col": ppLayoutTwoColumnText,
    "table": ppLayoutTitleOnly,
    "image": ppLayoutBlank,
    "blank": ppLayoutBlank,
}

LAYOUT_NAME_HINTS = {
    "title": ["제목 슬라이드", "title slide", "표지"],
    "section": ["구역", "section"],
    "bullets": ["제목 및 내용", "title and content", "content"],
    "two_col": ["콘텐츠 2개", "two content", "비교", "comparison"],
    "table": ["제목 및 내용", "title and content", "제목만", "title only"],
    "image": ["빈 화면", "blank", "그림", "picture"],
    "blank": ["빈 화면", "blank"],
}

LAYOUT_INDEX_FALLBACK = {
    "title": 1,
    "bullets": 2,
    "section": 3,
    "two_col": 4,
    "table": 6,
    "image": 7,
    "blank": 7,
}


def pick_custom_layout(pres, logical):
    try:
        layouts = pres.SlideMaster.CustomLayouts
        n = layouts.Count
    except Exception as exc:
        warn("custom layouts unavailable: %s" % exc)
        return None
    hints = LAYOUT_NAME_HINTS.get(logical, [])
    for i in range(1, n + 1):
        try:
            nm = (layouts.Item(i).Name or "").lower()
        except Exception:
            nm = ""
        for h in hints:
            if h.lower() in nm:
                return layouts.Item(i)
    idx = LAYOUT_INDEX_FALLBACK.get(logical, 2)
    if idx > n:
        idx = min(2, n)
    if idx < 1:
        idx = 1
    try:
        return layouts.Item(idx)
    except Exception:
        try:
            return layouts.Item(1)
        except Exception:
            return None


def add_slide(pres, use_sample, logical, at_index):
    if use_sample:
        layout = pick_custom_layout(pres, logical)
        if layout is not None:
            return pres.Slides.AddSlide(at_index, layout)
    return pres.Slides.Add(at_index, LOGICAL_TO_PPLAYOUT.get(logical, ppLayoutText))


def reuse_slide(pres, sample_index):
    rng = pres.Slides.Item(sample_index).Duplicate()
    try:
        dup = rng.Item(1)
    except Exception:
        dup = rng
    try:
        dup.MoveTo(pres.Slides.Count)
    except Exception:
        pass
    return dup


def fill_slide(sld, spec, logical, sw, sh, font):
    title = spec.get("title")
    subtitle = spec.get("subtitle")
    bullets = spec.get("bullets")
    bullets_right = spec.get("bullets_right")
    table = spec.get("table")
    image_path = spec.get("image_path")
    notes = spec.get("notes")

    if title:
        t = find_title(sld)
        if t is not None:
            set_text(t, title, font)
        else:
            try:
                tb = sld.Shapes.AddTextbox(
                    msoTextOrientationHorizontal, sw * 0.06, sh * 0.05, sw * 0.88, sh * 0.15
                )
                set_text(tb, title, font)
            except Exception as exc:
                warn("title textbox: %s" % exc)

    contents = content_placeholders(sld)

    if logical == "two_col" and (bullets or bullets_right):
        if len(contents) >= 2:
            if bullets:
                set_bullets(contents[0], bullets, font)
            if bullets_right:
                set_bullets(contents[1], bullets_right, font)
        else:
            half = sw * 0.44
            if bullets:
                tb = sld.Shapes.AddTextbox(msoTextOrientationHorizontal, sw * 0.04, sh * 0.25, half, sh * 0.6)
                set_bullets(tb, bullets, font)
            if bullets_right:
                tb = sld.Shapes.AddTextbox(msoTextOrientationHorizontal, sw * 0.52, sh * 0.25, half, sh * 0.6)
                set_bullets(tb, bullets_right, font)
    else:
        used_subtitle = False
        if subtitle:
            if contents:
                set_text(contents[0], subtitle, font)
                used_subtitle = True
            else:
                tb = sld.Shapes.AddTextbox(msoTextOrientationHorizontal, sw * 0.06, sh * 0.45, sw * 0.88, sh * 0.2)
                set_text(tb, subtitle, font)
        if bullets:
            target = None
            if used_subtitle and len(contents) >= 2:
                target = contents[1]
            elif not used_subtitle and contents:
                target = contents[0]
            if target is not None:
                set_bullets(target, bullets, font)
            else:
                tb = sld.Shapes.AddTextbox(msoTextOrientationHorizontal, sw * 0.06, sh * 0.25, sw * 0.88, sh * 0.65)
                set_bullets(tb, bullets, font)

    if table:
        add_table(sld, table, sw * 0.06, sh * 0.28, sw * 0.88, sh * 0.5)
    if image_path:
        add_picture(sld, os.path.abspath(image_path), sw * 0.1, sh * 0.25, sw * 0.8, sh * 0.6)
    if notes:
        set_notes(sld, notes)


# --- Consulting-style default template (used when NO sample is provided) -----
# A clean, on-brand look built programmatically (no external .pptx/.thmx needed,
# so it works on a closed corporate network): navy primary + blue accent, a
# title rule, styled bullets, a section divider with a full color background,
# and a footer with page number.

def rgb(r, g, b):
    # Office OLE color order is 0xBBGGRR, i.e. VBA RGB(r,g,b).
    return r + (g << 8) + (b << 16)


C_PRIMARY = rgb(0x1F, 0x38, 0x64)   # navy
C_ACCENT = rgb(0x2E, 0x75, 0xB6)    # blue accent
C_TEXT = rgb(0x40, 0x40, 0x40)      # body gray
C_MUTED = rgb(0x80, 0x80, 0x80)     # muted gray
C_LIGHT = rgb(0xF2, 0xF2, 0xF2)     # light fill
C_WHITE = rgb(0xFF, 0xFF, 0xFF)
C_SUBTLE = rgb(0xD0, 0xD8, 0xE8)    # light text on navy

msoShapeRectangle = 1
ppAlignLeft = 1
ppAlignCenter = 2
ppAlignRight = 3

FONT_LATIN = "Calibri"
FONT_KR = "맑은 고딕"


def add_rect(slide, left, top, width, height, color):
    try:
        shp = slide.Shapes.AddShape(msoShapeRectangle, left, top, width, height)
        shp.Fill.Solid()
        shp.Fill.ForeColor.RGB = color
        try:
            shp.Line.Visible = msoFalse
        except Exception:
            pass
        try:
            shp.Shadow.Visible = msoFalse
        except Exception:
            pass
        return shp
    except Exception as exc:
        warn("add_rect: %s" % exc)
        return None


def add_text(slide, left, top, width, height, text, size, color,
             bold=False, align=ppAlignLeft):
    try:
        tb = slide.Shapes.AddTextbox(msoTextOrientationHorizontal, left, top, width, height)
        tf = tb.TextFrame
        try:
            tf.WordWrap = msoTrue
            tf.MarginLeft = 0
            tf.MarginRight = 0
            tf.MarginTop = 0
            tf.MarginBottom = 0
        except Exception:
            pass
        tr = tf.TextRange
        tr.Text = _txt(text)
        try:
            tr.Font.Size = size
            tr.Font.Bold = msoTrue if bold else msoFalse
            tr.Font.Color.RGB = color
            tr.Font.Name = FONT_LATIN
            tr.Font.NameFarEast = FONT_KR
            tr.ParagraphFormat.Alignment = align
        except Exception as exc:
            warn("add_text font: %s" % exc)
        return tb
    except Exception as exc:
        warn("add_text: %s" % exc)
        return None


def add_bullets_box(slide, left, top, width, height, items, size=16):
    try:
        tb = slide.Shapes.AddTextbox(msoTextOrientationHorizontal, left, top, width, height)
        tf = tb.TextFrame
        try:
            tf.WordWrap = msoTrue
        except Exception:
            pass
        lines = []
        levels = []
        for it in items:
            if isinstance(it, dict):
                lines.append(_txt(it.get("text")))
                levels.append(int(it.get("level", 0) or 0))
            else:
                lines.append(_txt(it))
                levels.append(0)
        tr = tf.TextRange
        tr.Text = "\r".join(lines)
        try:
            tr.Font.Size = size
            tr.Font.Color.RGB = C_TEXT
            tr.Font.Name = FONT_LATIN
            tr.Font.NameFarEast = FONT_KR
            tr.ParagraphFormat.Alignment = ppAlignLeft
        except Exception:
            pass
        for i, lvl in enumerate(levels, start=1):
            try:
                p = tr.Paragraphs(i, 1)
                p.IndentLevel = min(lvl + 1, 5)
                try:
                    p.ParagraphFormat.SpaceAfter = 8
                except Exception:
                    pass
                try:
                    bullet = p.ParagraphFormat.Bullet
                    bullet.Visible = msoTrue
                    bullet.Character = 8226  # round bullet
                    bullet.Font.Color.RGB = C_ACCENT
                except Exception:
                    pass
            except Exception:
                pass
        return tb
    except Exception as exc:
        warn("add_bullets_box: %s" % exc)
        return None


def add_styled_table(slide, data, left, top, width, height):
    try:
        rows = len(data)
        cols = max((len(r) for r in data), default=0)
        if rows == 0 or cols == 0:
            return
        shp = slide.Shapes.AddTable(rows, cols, left, top, width, height)
        tbl = shp.Table
        for r in range(rows):
            for c in range(cols):
                val = data[r][c] if c < len(data[r]) else ""
                try:
                    cell = tbl.Cell(r + 1, c + 1)
                    tr = cell.Shape.TextFrame.TextRange
                    tr.Text = _txt(val)
                    tr.Font.Size = 12
                    tr.Font.Name = FONT_LATIN
                    tr.Font.NameFarEast = FONT_KR
                    if r == 0:
                        cell.Shape.Fill.ForeColor.RGB = C_PRIMARY
                        tr.Font.Bold = msoTrue
                        tr.Font.Color.RGB = C_WHITE
                    else:
                        cell.Shape.Fill.ForeColor.RGB = C_WHITE if (r % 2 == 1) else C_LIGHT
                        tr.Font.Color.RGB = C_TEXT
                except Exception:
                    pass
    except Exception as exc:
        warn("add_styled_table: %s" % exc)


def styled_slide(pres, spec, logical, sw, sh, idx, footer):
    """Build one consulting-styled slide from scratch on a blank layout."""
    sld = pres.Slides.Add(pres.Slides.Count + 1, ppLayoutBlank)
    try:
        sld.Layout = ppLayoutBlank
    except Exception:
        pass
    title = spec.get("title")
    subtitle = spec.get("subtitle")
    bullets = spec.get("bullets")
    bullets_right = spec.get("bullets_right")
    table = spec.get("table")
    image_path = spec.get("image_path")
    notes = spec.get("notes")

    mL = sw * 0.06
    content_w = sw - 2 * mL

    if logical == "title":
        add_rect(sld, 0, 0, sw * 0.022, sh, C_PRIMARY)
        add_text(sld, mL, sh * 0.33, content_w, sh * 0.20, title or "", 40, C_PRIMARY, bold=True)
        add_rect(sld, mL, sh * 0.55, sw * 0.18, sh * 0.008, C_ACCENT)
        if subtitle:
            add_text(sld, mL, sh * 0.58, content_w, sh * 0.12, subtitle, 18, C_MUTED)
        if notes:
            set_notes(sld, notes)
        return sld

    if logical == "section":
        try:
            sld.FollowMasterBackground = msoFalse
            sld.Background.Fill.Solid()
            sld.Background.Fill.ForeColor.RGB = C_PRIMARY
        except Exception as exc:
            warn("section background: %s" % exc)
            add_rect(sld, 0, 0, sw, sh, C_PRIMARY)
        add_rect(sld, mL, sh * 0.46, sw * 0.10, sh * 0.008, C_ACCENT)
        add_text(sld, mL, sh * 0.40, content_w, sh * 0.18, title or "", 34, C_WHITE, bold=True)
        if subtitle:
            add_text(sld, mL, sh * 0.60, content_w, sh * 0.10, subtitle, 16, C_SUBTLE)
        if notes:
            set_notes(sld, notes)
        return sld

    # --- content slides: title zone + accent rule + body + footer ---
    title_top = sh * 0.06
    title_h = sh * 0.12
    add_text(sld, mL, title_top, content_w, title_h, title or "", 24, C_PRIMARY, bold=True)
    add_rect(sld, mL, title_top + title_h, content_w, sh * 0.006, C_ACCENT)

    body_top = title_top + title_h + sh * 0.04
    body_bottom = sh * 0.90
    body_h = body_bottom - body_top

    if logical == "two_col":
        gap = sw * 0.04
        col_w = (content_w - gap) / 2
        if bullets:
            add_bullets_box(sld, mL, body_top, col_w, body_h, bullets)
        if bullets_right:
            add_bullets_box(sld, mL + col_w + gap, body_top, col_w, body_h, bullets_right)
    elif logical == "table" and table:
        add_styled_table(sld, table, mL, body_top, content_w, body_h)
    elif logical == "image" and image_path:
        add_picture(sld, os.path.abspath(image_path), mL, body_top, content_w, body_h)
    else:
        cur = body_top
        if subtitle:
            add_text(sld, mL, cur, content_w, sh * 0.08, subtitle, 16, C_MUTED)
            cur += sh * 0.09
        if bullets:
            add_bullets_box(sld, mL, cur, content_w, body_bottom - cur, bullets)
        elif subtitle is None and not table and not image_path:
            pass
        if table:
            add_styled_table(sld, table, mL, cur, content_w, body_bottom - cur)
        if image_path:
            add_picture(sld, os.path.abspath(image_path), mL, cur, content_w, body_bottom - cur)

    # footer rule + page number
    add_rect(sld, mL, sh * 0.925, content_w, sh * 0.003, C_LIGHT)
    if footer:
        add_text(sld, mL, sh * 0.93, content_w * 0.7, sh * 0.05, footer, 9, C_MUTED)
    add_text(sld, sw - mL - sw * 0.12, sh * 0.93, sw * 0.12, sh * 0.05, str(idx), 9, C_MUTED, align=ppAlignRight)

    if notes:
        set_notes(sld, notes)
    return sld


def main():
    _utf8()
    if len(sys.argv) < 3:
        sys.stderr.write("USAGE: build.py <spec.json> <out.pptx>\n")
        return 2
    spec_path = sys.argv[1]
    out_path = os.path.abspath(sys.argv[2])
    try:
        with open(spec_path, "r", encoding="utf-8") as f:
            spec = json.load(f)
    except Exception as exc:
        sys.stderr.write("SPEC_READ_ERROR: %s\n" % exc)
        return 2

    slides = spec.get("slides") or []
    sample = spec.get("sample_path")
    font = spec.get("default_font") or "맑은 고딕"
    footer = spec.get("footer")
    style = (spec.get("style") or "consulting").lower()
    use_sample = bool(sample)
    # When no sample is given, default to the built-in consulting template.
    consulting = (not use_sample) and style != "plain"

    if not ensure_pywin32():
        sys.stderr.write("WIN32COM_IMPORT_ERROR: pywin32 required.\n")
        return 4
    import win32com.client
    try:
        import pythoncom
        pythoncom.CoInitialize()
    except Exception:
        pass

    ppt = win32com.client.DispatchEx("PowerPoint.Application")
    pres = None
    try:
        if use_sample:
            pres = ppt.Presentations.Open(os.path.abspath(sample), ReadOnly=True, WithWindow=False)
            orig_count = pres.Slides.Count
        else:
            pres = ppt.Presentations.Add()
            try:
                pres.PageSetup.SlideWidth = 960
                pres.PageSetup.SlideHeight = 540
            except Exception:
                pass
            orig_count = 0

        try:
            sw = float(pres.PageSetup.SlideWidth)
            sh = float(pres.PageSetup.SlideHeight)
        except Exception:
            sw, sh = 960.0, 540.0

        # Analyze the sample's slides once so we can clone the best-fitting one.
        sample_prof = build_sample_index(pres, orig_count) if use_sample else {}

        cloned_count = 0
        for page_no, spec_slide in enumerate(slides, start=1):
            logical = (spec_slide.get("layout") or "bullets").lower()
            mode = (spec_slide.get("mode") or "auto").lower()
            cloned = False
            try:
                if consulting:
                    # Built-in consulting template (no sample): build + fill here.
                    styled_slide(pres, spec_slide, logical, sw, sh, page_no, footer)
                    continue
                if use_sample and mode == "themed_new":
                    # Explicit: fresh slide using only the sample's theme/layout.
                    sld = add_slide(pres, True, logical, pres.Slides.Count + 1)
                elif use_sample:
                    # Default for a sample deck: clone a real sample slide so its
                    # design (shapes, colors, fonts, positions) is preserved, then
                    # just swap the text. This is what makes the output look like
                    # the in-house deck instead of a plain themed slide.
                    si = None
                    if spec_slide.get("sample_slide_index"):
                        si = int(spec_slide["sample_slide_index"])
                        if si < 1 or si > orig_count:
                            warn("sample_slide_index out of range: %s" % si)
                            si = None
                    if si is None:
                        si = pick_source_slide(pres, orig_count, logical, sample_prof) or 1
                    sld = reuse_slide(pres, si)
                    cloned = True
                else:
                    sld = add_slide(pres, False, logical, pres.Slides.Count + 1)
            except Exception as exc:
                warn("add slide failed (%s): %s" % (logical, exc))
                continue
            if cloned:
                cloned_count += 1
                fill_cloned(sld, spec_slide, sw, sh)
            else:
                fill_slide(sld, spec_slide, logical, sw, sh, None if use_sample else font)

        if use_sample and orig_count > 0:
            for i in range(orig_count, 0, -1):
                try:
                    pres.Slides.Item(i).Delete()
                except Exception as exc:
                    warn("delete original slide %d: %s" % (i, exc))

        if pres.Slides.Count == 0:
            pres.Slides.Add(1, ppLayoutBlank)

        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        pres.SaveAs(out_path, ppSaveAsOpenXMLPresentation)
        pres.Close()
    except Exception as exc:
        sys.stderr.write("PPTX_BUILD_ERROR: %s\n" % exc)
        try:
            if pres is not None:
                pres.Close()
        except Exception:
            pass
        try:
            ppt.Quit()
        except Exception:
            pass
        return 5
    finally:
        try:
            ppt.Quit()
        except Exception:
            pass

    print(json.dumps({
        "output": out_path,
        "slides": len(slides),
        "sample_used": bool(use_sample),
        "sample_slides": int(orig_count) if use_sample else 0,
        "cloned": int(cloned_count),
        "style": (style if not use_sample else "sample"),
        "warnings": WARN,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
`;

class CreatePptxInvocation extends BaseToolInvocation<
  CreatePptxParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: CreatePptxParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ) {
    super(params, messageBus, toolName, toolDisplayName);
  }

  getDescription(): string {
    const n = this.params.slides?.length ?? 0;
    const ref = this.params.sample_path
      ? ` (sample: ${this.params.sample_path})`
      : '';
    return `Create a ${n}-slide PowerPoint deck${ref}`;
  }

  /** Resolves the output .pptx path, defaulting under <targetDir>/openrnd-ppt/. */
  private resolveOutputPath(): string {
    const { output_path } = this.params;
    if (output_path && output_path.trim()) {
      let p = output_path.trim();
      if (!p.toLowerCase().endsWith('.pptx')) {
        p = `${p}.pptx`;
      }
      return path.isAbsolute(p)
        ? path.resolve(p)
        : path.resolve(this.config.getTargetDir(), p);
    }
    const first = this.params.slides?.find((s) => s.title)?.title ?? 'deck';
    const fileName = `${slugify(first)}-${timestamp()}.pptx`;
    return path.resolve(
      this.config.getTargetDir(),
      DEFAULT_OUTPUT_DIR,
      fileName,
    );
  }

  async execute({ abortSignal }: ExecuteOptions): Promise<ToolResult> {
    const { slides } = this.params;

    if (!Array.isArray(slides) || slides.length === 0) {
      const msg = "'slides' is required and must contain at least one slide.";
      return {
        llmContent: `Error: ${msg}`,
        returnDisplay: `Error: ${msg}`,
        error: { message: msg, type: ToolErrorType.INVALID_TOOL_PARAMS },
      };
    }

    // PowerPoint COM automation is Windows-only (matches the rest of the
    // in-house tooling: read_outlook, the win32com Office reader, ...).
    if (process.platform !== 'win32') {
      const msg =
        'create_pptx는 설치된 PowerPoint를 win32com으로 구동하므로 Windows에서만 동작합니다. ' +
        `현재 플랫폼: ${process.platform}. 사내 Windows PC에서 실행해 주세요.`;
      return {
        llmContent: `Error: ${msg}`,
        returnDisplay: `Error: ${msg}`,
        error: { message: msg, type: ToolErrorType.EXECUTION_FAILED },
      };
    }

    const outPath = this.resolveOutputPath();

    // Keep generated files inside the workspace.
    const validationError = this.config.validatePathAccess(outPath, 'write');
    if (validationError) {
      return {
        llmContent: `Error: ${validationError}`,
        returnDisplay: 'Output path is not in the workspace.',
        error: {
          message: validationError,
          type: ToolErrorType.PATH_NOT_IN_WORKSPACE,
        },
      };
    }

    // Resolve and verify the sample deck (user-provided input; may live outside
    // the workspace, so we only check existence — not workspace membership).
    let samplePath: string | undefined;
    if (this.params.sample_path && this.params.sample_path.trim()) {
      const sp = this.params.sample_path.trim();
      samplePath = path.isAbsolute(sp)
        ? path.resolve(sp)
        : path.resolve(this.config.getTargetDir(), sp);
      try {
        await fs.access(samplePath);
      } catch {
        const msg = `Sample deck not found: ${samplePath}`;
        return {
          llmContent: `Error: ${msg}`,
          returnDisplay: `Error: ${msg}`,
          error: { message: msg, type: ToolErrorType.INVALID_TOOL_PARAMS },
        };
      }
    }

    const timeout = Math.min(
      (this.params.timeout_seconds ?? DEFAULT_TIMEOUT_MS / 1000) * 1000,
      MAX_TIMEOUT_MS,
    );

    const tmpScript = path.join(os.tmpdir(), `openrnd_pptx_${randomUUID()}.py`);
    const tmpSpec = path.join(os.tmpdir(), `openrnd_pptx_${randomUUID()}.json`);

    try {
      await fs.mkdir(path.dirname(outPath), { recursive: true });
      await fs.writeFile(tmpScript, PPTX_BUILD_SCRIPT, 'utf-8');
      await fs.writeFile(
        tmpSpec,
        JSON.stringify({
          slides,
          sample_path: samplePath ?? null,
          style: this.params.style ?? 'consulting',
          footer: this.params.footer ?? null,
        }),
        'utf-8',
      );

      const pythonExe = detectPythonExecutable();
      let stdout = '';
      let stderr = '';
      let killed = false;

      await new Promise<void>((resolve, reject) => {
        // No shell: pass argv straight to CreateProcessW as Unicode so Korean
        // paths / file names survive (see python-exec.ts / officeReader.ts).
        const child = spawn(pythonExe, [tmpScript, tmpSpec, outPath], {
          env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
          windowsHide: true,
        });

        const timer = setTimeout(() => {
          killed = true;
          child.kill();
        }, timeout);

        const abortHandler = () => {
          killed = true;
          child.kill();
        };
        abortSignal.addEventListener('abort', abortHandler, { once: true });

        child.stdout.on('data', (d: Buffer) => {
          stdout += d.toString('utf-8');
        });
        child.stderr.on('data', (d: Buffer) => {
          stderr += d.toString('utf-8');
        });
        child.on('error', (err) => {
          clearTimeout(timer);
          abortSignal.removeEventListener('abort', abortHandler);
          if (err.message.includes('ENOENT')) {
            reject(
              new Error(
                `Python 실행 파일 '${pythonExe}' 을(를) 찾을 수 없습니다. ` +
                  `Python 3 와 pywin32 (pip install pywin32), 그리고 PowerPoint가 설치되어 있어야 합니다.`,
              ),
            );
          } else {
            reject(err);
          }
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          abortSignal.removeEventListener('abort', abortHandler);
          if (killed) {
            reject(
              new Error(
                `PowerPoint 생성이 ${timeout / 1000}s 후 타임아웃되었거나 중단되었습니다.`,
              ),
            );
          } else if (code !== 0) {
            reject(
              new Error(
                `PowerPoint 생성 실패 (exit ${code}). ` +
                  (stderr.trim() || '진단 메시지 없음'),
              ),
            );
          } else {
            resolve();
          }
        });
      });

      // Parse the one-line JSON summary the script prints on success.
      let warnings: string[] = [];
      let sampleUsed = false;
      let sampleSlides = 0;
      let clonedCount = 0;
      try {
        const lastLine = stdout.trim().split('\n').pop() ?? '';
        const summary: unknown = JSON.parse(lastLine);
        if (summary && typeof summary === 'object') {
          if ('warnings' in summary) {
            const w: unknown = summary.warnings;
            if (Array.isArray(w)) {
              warnings = w.filter((x): x is string => typeof x === 'string');
            }
          }
          if ('sample_used' in summary) {
            sampleUsed = summary.sample_used === true;
          }
          if ('sample_slides' in summary) {
            const v: unknown = summary.sample_slides;
            if (typeof v === 'number') sampleSlides = v;
          }
          if ('cloned' in summary) {
            const v: unknown = summary.cloned;
            if (typeof v === 'number') clonedCount = v;
          }
        }
      } catch {
        // Non-fatal: the deck was still written (exit 0).
      }

      let opened = false;
      let openError: string | undefined;
      if (this.params.open !== false) {
        try {
          await open(outPath);
          opened = true;
        } catch (e) {
          openError = getErrorMessage(e);
          debugLogger.warn(
            `[create_pptx] Failed to open ${outPath}: ${openError}`,
          );
        }
      }

      const note = opened
        ? 'PowerPoint에서 열었습니다.'
        : this.params.open === false
          ? '파일을 열지 않았습니다 (open=false).'
          : `자동으로 열지 못했습니다 (${openError}). 직접 열어 주세요.`;
      const warnText =
        warnings.length > 0
          ? `\n경고 ${warnings.length}건:\n- ${warnings.slice(0, 10).join('\n- ')}`
          : '';

      // Make the sample/design outcome explicit so a missing sample_path is
      // immediately visible (the most common reason the design isn't applied).
      const sampleLine = samplePath
        ? sampleUsed
          ? `샘플 디자인 적용: 예 (샘플 ${sampleSlides}장 중 ${clonedCount}장 복제) — \`${samplePath}\``
          : `샘플 열기 실패 — 기본 템플릿으로 생성됨 (\`${samplePath}\`)`
        : '샘플 미사용 — 기본 템플릿으로 생성됨 (디자인을 따라하려면 sample_path 를 넘기세요)';

      const llmSampleLine = samplePath
        ? `Sample design applied: ${sampleUsed ? `yes (cloned ${clonedCount} of ${sampleSlides} sample slides)` : 'NO — sample failed to open, default template used'} [${samplePath}]`
        : 'Sample used: NO (no sample_path was provided). If the user wanted the deck to match an existing file, re-run create_pptx with that file path as sample_path.';

      return {
        llmContent:
          `PowerPoint deck written to: ${outPath}\n` +
          `Slides: ${slides.length}\n${llmSampleLine}\n${note}` +
          (warnings.length ? `\nWarnings: ${warnings.join(' | ')}` : ''),
        returnDisplay:
          `📊 PPT 생성 완료 (${slides.length}장)\n\n- 파일: \`${outPath}\`` +
          `\n- ${sampleLine}` +
          `\n- ${note}${warnText}`,
      };
    } catch (error) {
      const msg = getErrorMessage(error);
      return {
        llmContent: `Error creating PowerPoint: ${msg}`,
        returnDisplay: `Error creating PowerPoint: ${msg}`,
        error: { message: msg, type: ToolErrorType.EXECUTION_FAILED },
      };
    } finally {
      await fs.rm(tmpScript, { force: true }).catch(() => {});
      await fs.rm(tmpSpec, { force: true }).catch(() => {});
    }
  }
}

/**
 * Built-in tool that generates a PowerPoint (.pptx) deck by driving the
 * installed PowerPoint application via win32com. An optional sample deck is used
 * as a style reference (theme, fonts, colors, layouts, slides) so the result
 * matches the in-house "feel"; because it goes through PowerPoint, DRM-protected
 * in-house samples are supported. Windows-only.
 */
export class CreatePptxTool extends BaseDeclarativeTool<
  CreatePptxParams,
  ToolResult
> {
  static readonly Name = CREATE_PPTX_TOOL_NAME;

  constructor(
    private readonly config: Config,
    messageBus: MessageBus,
  ) {
    super(
      CreatePptxTool.Name,
      CREATE_PPTX_DISPLAY_NAME,
      'Create a PowerPoint (.pptx) deck for internal reporting/sharing and open it. Use this ' +
        'whenever the user asks to make slides or a deck — Korean triggers include PPT/피피티/' +
        '슬라이드/장표 만들어줘, 보고서 슬라이드로, 발표자료 만들어줘. Provide the content as a ' +
        'list of "slides" (each with a layout and fields like title, subtitle, bullets, table, ' +
        'image_path, notes). IMPORTANT: whenever the user provides or points at an existing deck ' +
        'to match the look of, you MUST pass its path as "sample_path" (do NOT just read it for ' +
        'reference) — that file is what carries the design. The tool opens the sample through ' +
        'PowerPoint (so DRM-protected in-house files work) and, by default, CLONES the matching ' +
        "sample slide and swaps its text, so the result keeps the sample's real design (shapes, " +
        'colors, fonts, positions) — not just the theme. Per slide you can set mode="reuse" with ' +
        'sample_slide_index to clone a specific sample slide, or mode="themed_new" for a plain ' +
        'theme-only slide. With NO sample, a built-in consulting-style template is applied by ' +
        'default (navy/accent palette, title rules, styled bullets, section dividers, footer + ' +
        'page numbers); pass style="plain" for the default PowerPoint theme, and "footer" for a ' +
        'footer label. The deck is saved (default under <workspace>/openrnd-ppt/) and opened in ' +
        'PowerPoint. Windows + PowerPoint only.',
      Kind.Other,
      {
        type: 'object',
        properties: {
          slides: {
            type: 'array',
            description:
              'Ordered slides to generate. Each slide picks a logical layout and fills the ' +
              'relevant fields; empty/omitted fields are skipped.',
            items: {
              type: 'object',
              properties: {
                layout: {
                  type: 'string',
                  enum: [
                    'title',
                    'section',
                    'bullets',
                    'two_col',
                    'table',
                    'image',
                    'blank',
                  ],
                  description:
                    "Logical layout: 'title' (cover), 'section' (divider), 'bullets' " +
                    "(title + bullet body), 'two_col' (two bullet columns), 'table', " +
                    "'image', or 'blank'. Default: 'bullets'.",
                },
                mode: {
                  type: 'string',
                  enum: ['auto', 'reuse', 'themed_new'],
                  description:
                    "How to realize the slide when a sample is given. 'auto' (default) clones the " +
                    "best-matching sample slide and swaps its text (keeps the sample's real " +
                    "design); 'reuse' clones the specific sample slide at sample_slide_index; " +
                    "'themed_new' composes a fresh slide using only the sample's theme (plainer). " +
                    'Ignored without a sample.',
                },
                sample_slide_index: {
                  type: 'number',
                  description:
                    "1-based index of the sample slide to clone when mode is 'reuse'.",
                },
                title: { type: 'string', description: 'Slide title.' },
                subtitle: {
                  type: 'string',
                  description:
                    'Subtitle / lead text (title & section layouts).',
                },
                bullets: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'Bullet lines for the body (or the left column of two_col). Prefix with ' +
                    'leading spaces is NOT how you nest — keep one idea per line.',
                },
                bullets_right: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'Bullet lines for the right column of a two_col layout.',
                },
                table: {
                  type: 'array',
                  items: { type: 'array', items: { type: 'string' } },
                  description:
                    'Table data as rows of string cells; the first row is the header.',
                },
                image_path: {
                  type: 'string',
                  description:
                    'Absolute or workspace-relative path to an image to place on the slide.',
                },
                notes: {
                  type: 'string',
                  description: 'Presenter notes for this slide.',
                },
              },
            },
          },
          sample_path: {
            type: 'string',
            description:
              'Optional reference .ppt/.pptx whose style (theme, fonts, colors, layouts, slides) ' +
              'the generated deck should match. In-house DRM-protected files are supported because ' +
              'they are opened through PowerPoint.',
          },
          output_path: {
            type: 'string',
            description:
              'Optional .pptx output path (absolute or relative to the workspace). ' +
              'Defaults to <workspace>/openrnd-ppt/<slug>-<timestamp>.pptx.',
          },
          style: {
            type: 'string',
            enum: ['consulting', 'plain'],
            description:
              "Visual style used only when NO sample is provided. 'consulting' (default) " +
              'applies a built-in consulting-style template (navy/accent colors, title rules, ' +
              "styled bullets, section dividers, footer + page numbers); 'plain' uses the " +
              'default PowerPoint theme. Ignored when sample_path is set.',
          },
          footer: {
            type: 'string',
            description:
              'Optional footer label shown on content slides (e.g. team name or ' +
              '"Confidential"). Used with the consulting style.',
          },
          open: {
            type: 'boolean',
            description:
              'Whether to open the generated deck in PowerPoint. Default: true.',
          },
          timeout_seconds: {
            type: 'number',
            description: 'Max build time in seconds (default 180, max 600).',
          },
        },
        required: ['slides'],
      },
      messageBus,
      true, // isOutputMarkdown
      false, // canUpdateOutput
    );
  }

  protected createInvocation(
    params: CreatePptxParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ): ToolInvocation<CreatePptxParams, ToolResult> {
    return new CreatePptxInvocation(
      this.config,
      params,
      messageBus,
      toolName,
      toolDisplayName,
    );
  }
}
