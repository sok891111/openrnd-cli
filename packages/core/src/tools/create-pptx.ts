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
import { PPTX_REGION_HELPERS } from './pptx-region-helpers.js';

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
  | 'content'
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
  /**
   * Slide title. For content slides write an "action title" — a full-sentence
   * takeaway ("매출은 전년 대비 12% 성장하며 목표를 초과 달성했다"), not a topic
   * label ("매출 현황"). This is what makes a deck read like a consultant's.
   */
  title?: string;
  /** Subtitle / lead text (title & section layouts). */
  subtitle?: string;
  /**
   * Rich content blocks rendered top-to-bottom (consulting/no-sample style).
   * Prefer this over plain `bullets` for professional layouts. Each block:
   *   { type: 'bullets',  items: string[] }
   *   { type: 'columns',  columns: [{ heading?: string, bullets: string[] }] }
   *   { type: 'kpis',     items: [{ value: string, label: string }] }   // stat cards
   *   { type: 'callout',  text: string }                                 // highlighted insight
   *   { type: 'table',    rows: string[][] }                             // first row = header
   *   { type: 'text',     text: string }
   *   // shape/icon infographics (no charts) — these read like a consultant's deck:
   *   { type: 'process',  steps:  [{ title, text?, icon? }] }   // chevron/arrow step flow
   *   { type: 'timeline', events: [{ label, title, text?, icon? }] } // horizontal roadmap
   * `icon` is a semantic name (e.g. "people", "search", "globe", "warning",
   * "check", "settings", "star", "document") drawn in an accent circle.
   */
  body?: CreatePptxBlock[];
  /** One-line "so-what" shown in a highlighted bar at the bottom of the slide. */
  takeaway?: string;
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
  /**
   * Region-addressed content for a cloned sample slide. Use together with a
   * sample deck and mode 'reuse'/'auto', after calling analyze_pptx_template:
   * each entry targets one text region by its structural-path `id` (e.g. "3",
   * "3.2", "5.r2c1") and replaces that region's text. All original text on the
   * cloned slide is cleared first; any region you omit is left blank while the
   * design (shapes/colors/fonts) is preserved. Ignored without a sample.
   */
  regions?: CreatePptxRegion[];
  /**
   * Name of the template CustomLayout to ADD for this slide — copy a `name` from
   * analyze_pptx_template's `style_guide.available_layouts`. This picks the slide
   * TYPE; vary it across slides so the deck uses the right layouts instead of one
   * repeated layout. With a sample deck only; falls back to `layout`/heuristic if
   * the name isn't found.
   */
  layout_name?: string;
  /** 1-based index of the template CustomLayout to add (fallback for layout_name). */
  layout_index?: number;
  /**
   * Fill the added template slide's placeholders BY idx. Use after
   * analyze_pptx_template: each entry targets one placeholder of the chosen
   * layout by its `idx` (from available_layouts[].placeholders) and writes
   * text/bullets there. This is how you place the title, heading, and body into
   * their correct regions instead of dumping everything into one box. With a
   * sample deck only.
   */
  placeholders?: CreatePptxPlaceholder[];
}

/** A single placeholder-addressed fill instruction for an added template slide. */
export interface CreatePptxPlaceholder {
  /** PlaceholderFormat idx of the target placeholder (from available_layouts). */
  idx: number;
  /** Plain text to place in the placeholder. */
  text?: string;
  /** Bullet lines to place in the placeholder (takes precedence over `text`). */
  bullets?: string[];
}

/** A single region-addressed fill instruction for a cloned sample slide. */
export interface CreatePptxRegion {
  /** Structural-path id of the target text region (from analyze_pptx_template). */
  id: string;
  /** Plain text to place in the region. */
  text?: string;
  /** Bullet lines to place in the region (takes precedence over `text`). */
  bullets?: string[];
}

/** A single step in a `process` infographic block. */
export interface CreatePptxStep {
  title: string;
  text?: string;
  /** Semantic icon name drawn in an accent circle (e.g. "search", "people"). */
  icon?: string;
}

/** A single milestone in a `timeline` infographic block. */
export interface CreatePptxEvent {
  /** Short label shown above the marker (e.g. a date or phase: "1분기"). */
  label: string;
  title: string;
  text?: string;
  /** Semantic icon name drawn in the marker (e.g. "flag", "check"). */
  icon?: string;
}

/** A content block in a consulting-style slide body. */
export interface CreatePptxBlock {
  type:
    | 'bullets'
    | 'columns'
    | 'kpis'
    | 'callout'
    | 'table'
    | 'text'
    | 'process'
    | 'timeline';
  items?:
    | Array<string | { text: string; level?: number }>
    | Array<{
        value: string;
        label: string;
      }>;
  columns?: Array<{ heading?: string; bullets: string[] }>;
  rows?: string[][];
  text?: string;
  /** For `process`: ordered steps drawn as a chevron/arrow flow. */
  steps?: CreatePptxStep[];
  /** For `timeline`: ordered milestones drawn on a horizontal roadmap. */
  events?: CreatePptxEvent[];
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
  /** Optional brand primary color (hex, e.g. "1F3864") for the consulting style. */
  primary?: string;
  /** Optional brand accent color (hex, e.g. "2E75B6") for the consulting style. */
  accent?: string;
  /**
   * Latin/heading font for the consulting style (e.g. from a sample's
   * style_guide). Defaults to "Calibri". Applies only without a sample.
   */
  font?: string;
  /**
   * East-Asian (Korean) font for the consulting style (e.g. from a sample's
   * style_guide). Defaults to "맑은 고딕". Applies only without a sample.
   */
  font_kr?: string;
  /** Slide aspect for the consulting style: "16:9" (default) or "4:3". */
  aspect?: '16:9' | '4:3';
  /** Explicit slide width in inches (overrides `aspect`). */
  slide_width_in?: number;
  /** Explicit slide height in inches (overrides `aspect`). */
  slide_height_in?: number;
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
const PPTX_BUILD_SCRIPT =
  String.raw`# -*- coding: utf-8 -*-
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

` +
  PPTX_REGION_HELPERS +
  String.raw`

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


def _left(shp):
    try:
        return float(shp.Left)
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

    # Wipe EVERY text region first (incl. group children and table cells) so none
    # of the sample's original wording lingers anywhere, then write the new
    # content into the chosen top-level frames below. text_frames() only sees
    # top-level shapes, which is fine for *placing* title/body, but clearing must
    # recurse — that is why original text used to survive inside grouped shapes.
    clear_all_text(slide)

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

    # (No leftover-clear loop needed: clear_all_text() above already blanked every
    # region, including the ones we didn't refill.)

    if table:
        add_table(slide, table, sw * 0.06, sh * 0.55, sw * 0.88, sh * 0.4)
    if image_path:
        add_picture(slide, os.path.abspath(image_path), sw * 0.55, sh * 0.2, sw * 0.4, sh * 0.5)
    if notes:
        set_notes(slide, notes)


def fill_by_regions(slide, spec, sw, sh):
    """Region-addressed fill for a cloned sample slide: wipe ALL original text,
    then write each requested region's new content into the shape with the
    matching structural-path id. Ids come from the analyze tool, which used the
    identical iter_text_regions() walk, so they line up on the clone. Any region
    not supplied is simply left blank — the design (shapes/colors/fonts) stays."""
    clear_all_text(slide)

    # id -> shape map for this clone (ids match what analyze_pptx_template reported).
    idmap = {}
    for rid, shp, _kind in iter_text_regions(slide):
        idmap[rid] = shp

    provided = set()
    for reg in (spec.get("regions") or []):
        if not isinstance(reg, dict):
            continue
        rid = reg.get("id")
        if rid is None:
            continue
        rid = str(rid)
        shp = idmap.get(rid)
        if shp is None:
            warn("region id not found on slide: %s" % rid)
            continue
        provided.add(rid)
        bullets = reg.get("bullets")
        if bullets:
            set_bullets(shp, bullets, None)
        elif reg.get("text") is not None:
            set_text(shp, reg.get("text"), None)

    # Title fallback: if the model passed a top-level "title" but did not target
    # the title region explicitly, fill it so the slide is never left title-less.
    title = spec.get("title")
    if title:
        t = find_title(slide)
        if t is not None:
            tid = None
            try:
                for rid, shp, _kind in iter_text_regions(slide):
                    try:
                        if shp.Id == t.Id:
                            tid = rid
                            break
                    except Exception:
                        pass
            except Exception:
                pass
            if tid is None or tid not in provided:
                set_text(t, title, None)

    # Extra content placed on top of the template, mirroring fill_cloned.
    table = spec.get("table")
    image_path = spec.get("image_path")
    notes = spec.get("notes")
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


def find_custom_layout(pres, layout_name, layout_index, logical):
    """Pick the template CustomLayout the model explicitly asked for: by exact then
    substring NAME (a name copied from analyze_pptx_template's available_layouts),
    then by 1-based INDEX, then fall back to the logical-name heuristic. This is
    what lets the model add DIFFERENT slide types instead of always landing on the
    same one."""
    try:
        layouts = pres.SlideMaster.CustomLayouts
        n = layouts.Count
    except Exception:
        return pick_custom_layout(pres, logical)
    if layout_name:
        want = str(layout_name).strip().lower()
        if want:
            for i in range(1, n + 1):
                try:
                    if (layouts.Item(i).Name or "").strip().lower() == want:
                        return layouts.Item(i)
                except Exception:
                    pass
            for i in range(1, n + 1):
                try:
                    nm = (layouts.Item(i).Name or "").strip().lower()
                    if nm and (want in nm or nm in want):
                        return layouts.Item(i)
                except Exception:
                    pass
            warn("layout_name not found, falling back: %s" % layout_name)
    if layout_index:
        try:
            idx = int(layout_index)
            if 1 <= idx <= n:
                return layouts.Item(idx)
            warn("layout_index out of range: %s" % layout_index)
        except Exception:
            pass
    return pick_custom_layout(pres, logical)


def add_slide(pres, use_sample, logical, at_index, layout_name=None, layout_index=None):
    if use_sample:
        layout = find_custom_layout(pres, layout_name, layout_index, logical)
        if layout is not None:
            return pres.Slides.AddSlide(at_index, layout)
    return pres.Slides.Add(at_index, LOGICAL_TO_PPLAYOUT.get(logical, ppLayoutText))


def fill_by_placeholders(slide, spec, sw, sh):
    """Fill a freshly-added template slide by PLACEHOLDER idx. The model picked a
    layout (layout_name) and says which placeholder — by the idx reported in
    analyze_pptx_template's available_layouts — gets which text/bullets. A slide
    added from a layout inherits each placeholder with the SAME idx, so idx is the
    reliable join key: content lands in the intended region (title vs heading vs
    body) instead of everything piling into one shape."""
    idmap = {}
    try:
        for ph in slide.Shapes.Placeholders:
            try:
                idmap[int(ph.PlaceholderFormat.idx)] = ph
            except Exception:
                pass
    except Exception as exc:
        warn("placeholders unavailable: %s" % exc)

    provided = set()
    for item in (spec.get("placeholders") or []):
        if not isinstance(item, dict):
            continue
        try:
            idx = int(item.get("idx"))
        except Exception:
            warn("placeholder entry missing numeric idx: %s" % item)
            continue
        ph = idmap.get(idx)
        if ph is None:
            warn("placeholder idx not on slide: %s" % idx)
            continue
        provided.add(idx)
        bullets = item.get("bullets")
        if bullets:
            set_bullets(ph, bullets, None)
        elif item.get("text") is not None:
            set_text(ph, item.get("text"), None)

    # Title fallback: honor a top-level "title" if the title placeholder wasn't
    # targeted explicitly, so the slide is never left title-less.
    title = spec.get("title")
    if title:
        t = find_title(slide)
        if t is not None:
            try:
                tidx = int(t.PlaceholderFormat.idx)
            except Exception:
                tidx = None
            if tidx is None or tidx not in provided:
                set_text(t, title, None)

    # Extra content drawn on top of the template, mirroring fill_cloned.
    table = spec.get("table")
    image_path = spec.get("image_path")
    notes = spec.get("notes")
    if table:
        add_table(slide, table, sw * 0.06, sh * 0.55, sw * 0.88, sh * 0.4)
    if image_path:
        add_picture(slide, os.path.abspath(image_path), sw * 0.55, sh * 0.2, sw * 0.4, sh * 0.5)
    if notes:
        set_notes(slide, notes)


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


def flatten_body_to_bullets(body):
    """Turn rich consulting body blocks into (bullet lines, tables) so they can
    be placed into the template's styled body placeholder. We intentionally render
    into the placeholder (rather than drawing custom shapes) so the text inherits
    the template's real fonts/bullet styling — that is what makes it look like the
    in-house deck. Returns (lines, tables) where lines are {text, level} dicts."""
    lines = []
    tables = []
    if not isinstance(body, list):
        return lines, tables
    for blk in body:
        if not isinstance(blk, dict):
            lines.append({"text": _txt(blk), "level": 0})
            continue
        t = (blk.get("type") or "").lower()
        if t == "bullets":
            for it in (blk.get("items") or []):
                if isinstance(it, dict):
                    lines.append({"text": _txt(it.get("text")), "level": int(it.get("level", 0) or 0)})
                else:
                    lines.append({"text": _txt(it), "level": 0})
        elif t == "columns":
            for col in (blk.get("columns") or []):
                if not isinstance(col, dict):
                    continue
                if col.get("heading"):
                    lines.append({"text": _txt(col.get("heading")), "level": 0})
                for b in (col.get("bullets") or []):
                    lines.append({"text": _txt(b), "level": 1})
        elif t == "kpis":
            for it in (blk.get("items") or []):
                if isinstance(it, dict):
                    v = _txt(it.get("value"))
                    lbl = _txt(it.get("label"))
                    lines.append({"text": (("%s — %s" % (v, lbl)).strip(" —") or v), "level": 0})
        elif t in ("callout", "text"):
            lines.append({"text": _txt(blk.get("text")), "level": 0})
        elif t == "process":
            steps = blk.get("steps") or blk.get("items") or []
            for i, st in enumerate(steps, start=1):
                if isinstance(st, dict):
                    title = _txt(st.get("title"))
                    tx = _txt(st.get("text"))
                    lines.append({"text": ("%d. %s" % (i, title)) + ((" — %s" % tx) if tx else ""), "level": 0})
                else:
                    lines.append({"text": "%d. %s" % (i, _txt(st)), "level": 0})
        elif t == "timeline":
            for ev in (blk.get("events") or blk.get("items") or []):
                if isinstance(ev, dict):
                    lab = _txt(ev.get("label"))
                    title = _txt(ev.get("title"))
                    tx = _txt(ev.get("text"))
                    head = ("%s: %s" % (lab, title)) if lab else title
                    lines.append({"text": head + ((" — %s" % tx) if tx else ""), "level": 0})
                else:
                    lines.append({"text": _txt(ev), "level": 0})
        elif t == "table":
            rows = blk.get("rows") or []
            if rows:
                tables.append(rows)
    return lines, tables


def fill_slide(sld, spec, logical, sw, sh, font):
    title = spec.get("title")
    subtitle = spec.get("subtitle")
    bullets = spec.get("bullets")
    bullets_right = spec.get("bullets_right")
    table = spec.get("table")
    image_path = spec.get("image_path")
    notes = spec.get("notes")

    # Rich body blocks (the consulting content model): flatten into bullets +
    # tables so nothing is lost when building on the template's layouts.
    if not bullets:
        body_lines, body_tables = flatten_body_to_bullets(spec.get("body"))
        if body_lines:
            bullets = body_lines
        if body_tables and not table:
            table = body_tables[0]

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
    # Order matters: for two_col keep left->right; otherwise put the LARGEST body
    # placeholder first so bullets land in the real body, not a small heading box
    # (this is what caused all text to pile into the "heading").
    if logical == "two_col":
        contents.sort(key=_left)
    else:
        contents.sort(key=_area, reverse=True)

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
                want_clone = use_sample and (
                    mode == "reuse"
                    or spec_slide.get("regions")
                    or spec_slide.get("sample_slide_index")
                )
                if want_clone:
                    # OPT-IN exact clone: duplicate a specific/auto-matched sample
                    # slide and replace its text. Brittle on complex templates —
                    # only used when the model explicitly asks (mode="reuse",
                    # sample_slide_index, or regions).
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
                elif use_sample:
                    # DEFAULT for a sample deck: add a FRESH slide built from the
                    # template's OWN layout (slide master), then fill its
                    # placeholders. This is how a template is meant to be used —
                    # the new slide inherits the template's background, logo,
                    # fonts and bullet styles, but starts with clean, empty
                    # placeholders, so content lands correctly instead of fighting
                    # a cloned content slide's existing shapes. The model picks the
                    # slide TYPE via layout_name/layout_index (from
                    # analyze_pptx_template's available_layouts); without one we
                    # fall back to the logical-name heuristic.
                    sld = add_slide(
                        pres, True, logical, pres.Slides.Count + 1,
                        spec_slide.get("layout_name"), spec_slide.get("layout_index"),
                    )
                else:
                    sld = add_slide(pres, False, logical, pres.Slides.Count + 1)
            except Exception as exc:
                warn("add slide failed (%s): %s" % (logical, exc))
                continue
            if cloned:
                cloned_count += 1
                if spec_slide.get("regions"):
                    # Precise region-addressed fill (paired with analyze_pptx_template).
                    fill_by_regions(sld, spec_slide, sw, sh)
                else:
                    fill_cloned(sld, spec_slide, sw, sh)
            else:
                if use_sample and spec_slide.get("placeholders"):
                    # Precise placeholder-addressed fill on a fresh template slide.
                    fill_by_placeholders(sld, spec_slide, sw, sh)
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

/**
 * Consultant-style renderer used when NO sample deck is given. Uses python-pptx
 * (cross-platform, no PowerPoint needed, so it also runs on the dev machine and
 * is unit-testable) to draw a clean McKinsey/BCG-like deck: full-sentence action
 * titles, an accent rule, structured content blocks (bullets / columns / KPI
 * callouts / insight callout / table / text), an optional "so-what" takeaway bar,
 * and a footer with page numbers. Reads the same JSON spec (argv[1]) and writes
 * the deck to argv[2]; prints a one-line JSON summary on success.
 */
const CONSULTING_PPTX_SCRIPT = String.raw`# -*- coding: utf-8 -*-
import os
import sys
import json


def ensure_pptx():
    try:
        import pptx  # noqa: F401
        return True
    except ImportError:
        pass
    import subprocess
    sys.stderr.write("PPTX_MISSING: installing python-pptx with %s\n" % sys.executable)
    try:
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "--user", "--quiet", "python-pptx"]
        )
        import pptx  # noqa: F401
        return True
    except Exception as exc:
        sys.stderr.write("PPTX_INSTALL_FAILED: %s\n" % exc)
        return False


WARN = []


def warn(m):
    WARN.append(str(m))


def _txt(v):
    return "" if v is None else str(v)


def main():
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    if len(sys.argv) < 3:
        sys.stderr.write("USAGE: consulting.py <spec.json> <out.pptx>\n")
        return 2
    spec_path = sys.argv[1]
    out_path = os.path.abspath(sys.argv[2])
    with open(spec_path, "r", encoding="utf-8") as f:
        spec = json.load(f)

    if not ensure_pptx():
        sys.stderr.write("PPTX_IMPORT_ERROR: python-pptx required.\n")
        return 4

    from pptx import Presentation
    from pptx.util import Inches, Pt
    from pptx.dml.color import RGBColor
    from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
    from pptx.enum.shapes import MSO_SHAPE
    from pptx.oxml.ns import qn

    slides = spec.get("slides") or []
    style = (spec.get("style") or "consulting").lower()
    footer = spec.get("footer")

    def hexcolor(h, default):
        h = (h or "").lstrip("#")
        try:
            return RGBColor.from_string(h)
        except Exception:
            return default

    C_PRIMARY = hexcolor(spec.get("primary"), RGBColor(0x1F, 0x38, 0x64))
    C_ACCENT = hexcolor(spec.get("accent"), RGBColor(0x2E, 0x75, 0xB6))
    C_TEXT = RGBColor(0x33, 0x33, 0x33)
    C_MUTED = RGBColor(0x7F, 0x7F, 0x7F)
    C_LIGHT = RGBColor(0xF2, 0xF4, 0xF7)
    C_WHITE = RGBColor(0xFF, 0xFF, 0xFF)
    C_SUBTLE = RGBColor(0xD0, 0xD8, 0xE8)

    # Fonts: honor the template-derived fonts (from analyze_pptx_template's
    # style_guide) when supplied, else the consulting defaults.
    FONT = spec.get("font") or "Calibri"
    FONT_KR = spec.get("font_kr") or "맑은 고딕"

    prs = Presentation()
    # Slide size: honor the template's aspect/size when supplied so the rebuilt
    # deck matches (e.g. 4:3 templates), else default to 16:9.
    def _dim(key, default_in):
        try:
            v = float(spec.get(key))
            if v > 0:
                return Inches(v)
        except Exception:
            pass
        return default_in
    aspect = (spec.get("aspect") or "").strip()
    if aspect == "4:3":
        def_w, def_h = Inches(10.0), Inches(7.5)
    else:
        def_w, def_h = Inches(13.333), Inches(7.5)
    prs.slide_width = _dim("slide_width_in", def_w)
    prs.slide_height = _dim("slide_height_in", def_h)
    SW = prs.slide_width
    SH = prs.slide_height
    BLANK = prs.slide_layouts[6]
    MARGIN = Inches(0.6)
    CONTENT_W = SW - 2 * MARGIN

    def set_font(run, size, color, bold=False):
        run.font.size = Pt(size)
        run.font.bold = bold
        run.font.color.rgb = color
        run.font.name = FONT
        try:
            rPr = run._r.get_or_add_rPr()
            ea = rPr.find(qn("a:ea"))
            if ea is None:
                ea = rPr.makeelement(qn("a:ea"), {})
                rPr.append(ea)
            ea.set("typeface", FONT_KR)
        except Exception:
            pass

    def add_rect(slide, left, top, width, height, color):
        shp = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, left, top, width, height)
        shp.fill.solid()
        shp.fill.fore_color.rgb = color
        shp.line.fill.background()
        shp.shadow.inherit = False
        return shp

    def add_text(slide, left, top, width, height, text, size, color,
                 bold=False, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP):
        tb = slide.shapes.add_textbox(left, top, width, height)
        tf = tb.text_frame
        tf.word_wrap = True
        tf.vertical_anchor = anchor
        tf.margin_left = 0
        tf.margin_right = 0
        tf.margin_top = 0
        tf.margin_bottom = 0
        p = tf.paragraphs[0]
        p.alignment = align
        run = p.add_run()
        run.text = _txt(text)
        set_font(run, size, color, bold)
        return tb

    def add_bullets(slide, left, top, width, height, items, size=15):
        tb = slide.shapes.add_textbox(left, top, width, height)
        tf = tb.text_frame
        tf.word_wrap = True
        tf.margin_left = 0
        tf.margin_right = 0
        for i, it in enumerate(items):
            if isinstance(it, dict):
                txt = _txt(it.get("text"))
                lvl = int(it.get("level", 0) or 0)
            else:
                txt = _txt(it)
                lvl = 0
            p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
            p.level = min(lvl, 4)
            p.space_after = Pt(6)
            run = p.add_run()
            run.text = ("▪ " if lvl == 0 else "– ") + txt
            set_font(run, size, C_TEXT)
        return tb

    # --- icon system (glyph + geometric shape, no charts) -------------------
    # Professional monoline icons via the Windows-bundled "Segoe MDL2 Assets"
    # font: each name maps to a Private-Use-Area glyph codepoint. The glyph is
    # drawn centered inside an accent-colored circle, so even if the font is
    # absent on the machine that *opens* the deck, the colored circle (and the
    # numeric/letter fallback) keeps the slide looking intentional. Only a
    # high-confidence MDL2 set is used; unknown names fall back to text.
    ICON_FONT = "Segoe MDL2 Assets"
    ICONS = {
        "check": "", "done": "", "success": "", "complete": "",
        "x": "", "cancel": "", "fail": "", "stop": "",
        "add": "", "plus": "", "new": "", "launch": "",
        "settings": "", "gear": "", "process": "", "ops": "",
        "people": "", "team": "", "customer": "", "hr": "",
        "person": "", "user": "", "lead": "",
        "mail": "", "email": "", "contact": "",
        "search": "", "find": "", "research": "", "analysis": "",
        "lock": "", "security": "", "compliance": "",
        "globe": "", "global": "", "world": "", "market": "",
        "warning": "", "risk": "", "alert": "", "issue": "",
        "info": "", "note": "",
        "star": "", "quality": "", "priority": "", "favorite": "",
        "doc": "", "document": "", "report": "", "file": "",
        "download": "", "import": "",
        "upload": "", "export": "", "share": "",
        "home": "", "company": "", "office": "",
        "flag": "\uE7C1", "goal": "\uE7C1", "target": "\uE7C1",
        "milestone": "\uE7C1", "objective": "\uE7C1",
        "calendar": "\uE787", "schedule": "\uE787", "date": "\uE787",
        "time": "\uE787", "clock": "\uE787", "plan": "\uE787",
        "phone": "\uE717", "call": "\uE717",
        "location": "\uE707", "place": "\uE707", "map": "\uE707",
        "region": "\uE707",
    }

    def _set_icon_typeface(run, face):
        try:
            rPr = run._r.get_or_add_rPr()
            for tag in ("a:latin", "a:cs", "a:ea"):
                el = rPr.find(qn(tag))
                if el is None:
                    el = rPr.makeelement(qn(tag), {})
                    rPr.append(el)
                el.set("typeface", face)
        except Exception:
            pass

    def add_icon_circle(slide, left, top, diameter, icon_name, fallback,
                        circle_color=None, glyph_color=None):
        """A filled circle holding either an MDL2 glyph (when icon_name is known)
        or the fallback text (e.g. a step number). Returns the circle shape."""
        circle_color = C_ACCENT if circle_color is None else circle_color
        glyph_color = C_WHITE if glyph_color is None else glyph_color
        shp = slide.shapes.add_shape(MSO_SHAPE.OVAL, left, top, diameter, diameter)
        shp.fill.solid()
        shp.fill.fore_color.rgb = circle_color
        shp.line.fill.background()
        shp.shadow.inherit = False
        tf = shp.text_frame
        tf.word_wrap = False
        tf.vertical_anchor = MSO_ANCHOR.MIDDLE
        for m in ("margin_left", "margin_right", "margin_top", "margin_bottom"):
            try:
                setattr(tf, m, 0)
            except Exception:
                pass
        p = tf.paragraphs[0]
        p.alignment = PP_ALIGN.CENTER
        run = p.add_run()
        glyph = ICONS.get((icon_name or "").strip().lower()) if icon_name else None
        d_in = diameter / 914400.0  # EMU -> inches
        if glyph:
            run.text = glyph
            run.font.size = Pt(max(8, int(d_in * 72 * 0.5)))
            run.font.color.rgb = glyph_color
            run.font.name = ICON_FONT
            _set_icon_typeface(run, ICON_FONT)
        else:
            run.text = _txt(fallback)
            run.font.size = Pt(max(9, int(d_in * 72 * 0.42)))
            run.font.bold = True
            run.font.color.rgb = glyph_color
            run.font.name = FONT
        return shp

    def render_title_slide(slide, s):
        add_rect(slide, 0, 0, Inches(0.22), SH, C_PRIMARY)
        add_text(slide, MARGIN, Inches(2.4), CONTENT_W, Inches(1.6),
                 s.get("title"), 40, C_PRIMARY, bold=True)
        add_rect(slide, MARGIN, Inches(4.05), Inches(2.2), Pt(4), C_ACCENT)
        if s.get("subtitle"):
            add_text(slide, MARGIN, Inches(4.25), CONTENT_W, Inches(0.9),
                     s.get("subtitle"), 18, C_MUTED)

    def render_section_slide(slide, s):
        add_rect(slide, 0, 0, SW, SH, C_PRIMARY)
        add_rect(slide, MARGIN, Inches(3.45), Inches(1.2), Pt(4), C_ACCENT)
        add_text(slide, MARGIN, Inches(2.9), CONTENT_W, Inches(1.4),
                 s.get("title"), 34, C_WHITE, bold=True)
        if s.get("subtitle"):
            add_text(slide, MARGIN, Inches(4.4), CONTENT_W, Inches(0.8),
                     s.get("subtitle"), 16, C_SUBTLE)

    def render_bullets_block(slide, blk, left, top, width, height):
        add_bullets(slide, left, top, width, height, blk.get("items") or [])

    def render_columns_block(slide, blk, left, top, width, height):
        cols = blk.get("columns") or []
        n = max(1, len(cols))
        gap = Inches(0.3)
        col_w = int((width - gap * (n - 1)) / n)
        for i, col in enumerate(cols):
            cx = left + i * (col_w + gap)
            ch_top = top
            if col.get("heading"):
                add_rect(slide, cx, ch_top, col_w, Inches(0.45), C_PRIMARY)
                add_text(slide, cx + Inches(0.12), ch_top, col_w - Inches(0.24),
                         Inches(0.45), col.get("heading"), 13, C_WHITE,
                         bold=True, anchor=MSO_ANCHOR.MIDDLE)
                ch_top = ch_top + Inches(0.55)
            add_bullets(slide, cx, ch_top, col_w, top + height - ch_top,
                        col.get("bullets") or [], size=13)

    def render_kpis_block(slide, blk, left, top, width, height):
        items = blk.get("items") or []
        n = max(1, len(items))
        gap = Inches(0.3)
        card_w = int((width - gap * (n - 1)) / n)
        card_h = min(height, Inches(1.9))
        for i, kpi in enumerate(items):
            cx = left + i * (card_w + gap)
            add_rect(slide, cx, top, card_w, card_h, C_LIGHT)
            add_rect(slide, cx, top, card_w, Pt(5), C_ACCENT)
            add_text(slide, cx + Inches(0.1), top + Inches(0.25), card_w - Inches(0.2),
                     Inches(0.9), kpi.get("value"), 32, C_PRIMARY, bold=True,
                     align=PP_ALIGN.CENTER)
            add_text(slide, cx + Inches(0.1), top + Inches(1.2), card_w - Inches(0.2),
                     Inches(0.6), kpi.get("label"), 12, C_MUTED,
                     align=PP_ALIGN.CENTER)

    def render_callout_block(slide, blk, left, top, width, height):
        h = min(height, Inches(1.4))
        add_rect(slide, left, top, width, h, C_LIGHT)
        add_rect(slide, left, top, Pt(5), h, C_ACCENT)
        add_text(slide, left + Inches(0.3), top, width - Inches(0.5), h,
                 blk.get("text"), 15, C_PRIMARY, bold=True, anchor=MSO_ANCHOR.MIDDLE)

    def render_text_block(slide, blk, left, top, width, height):
        add_text(slide, left, top, width, height, blk.get("text"), 15, C_TEXT)

    def render_table_block(slide, blk, left, top, width, height):
        rows = blk.get("rows") or []
        if not rows:
            return
        nrows = len(rows)
        ncols = max(len(r) for r in rows)
        th = min(height, Inches(0.4) * nrows)
        gtbl = slide.shapes.add_table(nrows, ncols, left, top, width, th).table
        for r in range(nrows):
            for c in range(ncols):
                val = rows[r][c] if c < len(rows[r]) else ""
                cell = gtbl.cell(r, c)
                cell.text = _txt(val)
                para = cell.text_frame.paragraphs[0]
                run = para.runs[0] if para.runs else para.add_run()
                if r == 0:
                    set_font(run, 12, C_WHITE, bold=True)
                    cell.fill.solid()
                    cell.fill.fore_color.rgb = C_PRIMARY
                else:
                    set_font(run, 11, C_TEXT)
                    cell.fill.solid()
                    cell.fill.fore_color.rgb = C_WHITE if r % 2 else C_LIGHT

    def render_process_block(slide, blk, left, top, width, height):
        """Horizontal step flow: an icon/number circle per step, the step title
        and optional detail beneath it, and an accent arrow between steps."""
        steps = blk.get("steps") or blk.get("items") or []
        n = len(steps)
        if n == 0:
            return
        gap = Inches(0.35)
        cell_w = int((width - gap * (n - 1)) / n)
        d = min(Inches(0.95), int(cell_w * 0.55), int(height * 0.45))
        circle_top = top
        for i, st in enumerate(steps):
            if not isinstance(st, dict):
                st = {"title": _txt(st)}
            cell_x = left + i * (cell_w + gap)
            # icon / number circle, centered in the cell
            cx = cell_x + int((cell_w - d) / 2)
            add_icon_circle(slide, cx, circle_top, d, st.get("icon"), str(i + 1))
            # title + detail under the circle
            ty = circle_top + d + Inches(0.12)
            add_text(slide, cell_x, ty, cell_w, Inches(0.5),
                     st.get("title"), 13, C_PRIMARY, bold=True,
                     align=PP_ALIGN.CENTER)
            if st.get("text"):
                add_text(slide, cell_x, ty + Inches(0.5), cell_w,
                         top + height - (ty + Inches(0.5)),
                         st.get("text"), 10, C_MUTED, align=PP_ALIGN.CENTER)
            # arrow to the next step, vertically centered on the circle band
            if i < n - 1:
                ax = cell_x + cell_w
                add_text(slide, ax, circle_top, gap, d, "→", 22, C_ACCENT,
                         bold=True, align=PP_ALIGN.CENTER,
                         anchor=MSO_ANCHOR.MIDDLE)

    def render_timeline_block(slide, blk, left, top, width, height):
        """Horizontal roadmap: a baseline with a marker per event, the date/phase
        label above the marker and the milestone title/detail below it."""
        events = blk.get("events") or blk.get("items") or []
        n = len(events)
        if n == 0:
            return
        line_y = top + int(height * 0.42)
        add_rect(slide, left, line_y, width, Pt(3), C_ACCENT)
        seg = int(width / n)
        d = min(Inches(0.5), int(seg * 0.4))
        for i, ev in enumerate(events):
            if not isinstance(ev, dict):
                ev = {"title": _txt(ev)}
            cx = left + int((i + 0.5) * seg)
            # label above the marker (date / phase)
            if ev.get("label"):
                add_text(slide, cx - int(seg / 2), top, seg,
                         line_y - top - Inches(0.05), ev.get("label"), 12,
                         C_PRIMARY, bold=True, align=PP_ALIGN.CENTER,
                         anchor=MSO_ANCHOR.BOTTOM)
            # marker (icon circle, or a plain accent dot)
            mx = cx - int(d / 2)
            my = line_y + int(Pt(3) / 2) - int(d / 2)
            if ev.get("icon"):
                add_icon_circle(slide, mx, my, d, ev.get("icon"), "")
            else:
                dot = slide.shapes.add_shape(MSO_SHAPE.OVAL, mx, my, d, d)
                dot.fill.solid()
                dot.fill.fore_color.rgb = C_PRIMARY
                dot.line.color.rgb = C_WHITE
                dot.line.width = Pt(2)
                dot.shadow.inherit = False
            # title + detail below the marker
            ty = my + d + Inches(0.08)
            add_text(slide, cx - int(seg / 2), ty, seg, Inches(0.5),
                     ev.get("title"), 12, C_TEXT, bold=True,
                     align=PP_ALIGN.CENTER)
            if ev.get("text"):
                add_text(slide, cx - int(seg / 2), ty + Inches(0.45), seg,
                         top + height - (ty + Inches(0.45)), ev.get("text"),
                         10, C_MUTED, align=PP_ALIGN.CENTER)

    BLOCK_RENDERERS = {
        "bullets": render_bullets_block,
        "columns": render_columns_block,
        "kpis": render_kpis_block,
        "callout": render_callout_block,
        "text": render_text_block,
        "table": render_table_block,
        "process": render_process_block,
        "timeline": render_timeline_block,
    }

    def normalize_blocks(s):
        body = s.get("body")
        if isinstance(body, list) and body:
            return body
        blocks = []
        if s.get("bullets"):
            blocks.append({"type": "bullets", "items": s.get("bullets")})
        if s.get("bullets_right"):
            blocks.append({"type": "bullets", "items": s.get("bullets_right")})
        if s.get("table"):
            blocks.append({"type": "table", "rows": s.get("table")})
        return blocks

    def render_content_slide(slide, s, page_no):
        add_text(slide, MARGIN, Inches(0.45), CONTENT_W, Inches(0.9),
                 s.get("title"), 22, C_PRIMARY, bold=True)
        add_rect(slide, MARGIN, Inches(1.32), CONTENT_W, Pt(2.5), C_ACCENT)

        body_top = Inches(1.65)
        body_bottom = SH - Inches(0.55)
        if s.get("takeaway"):
            body_bottom = body_bottom - Inches(0.7)
        avail_h = body_bottom - body_top

        blocks = normalize_blocks(s)
        if not blocks and s.get("subtitle"):
            blocks = [{"type": "text", "text": s.get("subtitle")}]

        if blocks:
            weights = []
            for b in blocks:
                t = (b.get("type") or "").lower()
                weights.append(2.5 if t in ("bullets", "columns", "table", "text", "process", "timeline") else 1.0)
            total = sum(weights) or 1
            gap = Inches(0.25)
            cur = body_top
            usable = avail_h - gap * (len(blocks) - 1)
            for b, w in zip(blocks, weights):
                bh = int(usable * (w / total))
                t = (b.get("type") or "").lower()
                renderer = BLOCK_RENDERERS.get(t)
                if renderer:
                    try:
                        renderer(slide, b, MARGIN, cur, CONTENT_W, bh)
                    except Exception as exc:
                        warn("block %s on slide %d failed: %s" % (t, page_no, exc))
                else:
                    warn("unknown block type: %s" % t)
                cur = cur + bh + gap

        if s.get("takeaway"):
            ty = SH - Inches(1.15)
            add_rect(slide, MARGIN, ty, CONTENT_W, Inches(0.6), C_PRIMARY)
            add_text(slide, MARGIN + Inches(0.2), ty, CONTENT_W - Inches(0.4),
                     Inches(0.6), "핵심: " + _txt(s.get("takeaway")), 13, C_WHITE,
                     bold=True, anchor=MSO_ANCHOR.MIDDLE)

        fy = SH - Inches(0.42)
        add_rect(slide, MARGIN, fy, CONTENT_W, Pt(1), C_LIGHT)
        if footer:
            add_text(slide, MARGIN, fy + Inches(0.03), int(CONTENT_W * 0.7),
                     Inches(0.3), footer, 9, C_MUTED)
        add_text(slide, SW - MARGIN - Inches(1.2), fy + Inches(0.03), Inches(1.2),
                 Inches(0.3), str(page_no), 9, C_MUTED, align=PP_ALIGN.RIGHT)

    for idx, s in enumerate(slides, start=1):
        layout = (s.get("layout") or "bullets").lower()
        slide = prs.slides.add_slide(BLANK)
        try:
            if layout == "title":
                render_title_slide(slide, s)
            elif layout == "section":
                render_section_slide(slide, s)
            else:
                render_content_slide(slide, s, idx)
        except Exception as exc:
            warn("slide %d (%s) failed: %s" % (idx, layout, exc))

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    prs.save(out_path)
    print(json.dumps({
        "output": out_path,
        "slides": len(slides),
        "engine": "python-pptx",
        "sample_used": False,
        "style": style,
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

    const usingSample = !!(
      this.params.sample_path && this.params.sample_path.trim()
    );

    // Cloning a (DRM) sample deck must drive PowerPoint via win32com → Windows
    // only. The no-sample consulting deck uses python-pptx, which is
    // cross-platform, so we only gate the sample path on Windows.
    if (usingSample && process.platform !== 'win32') {
      const msg =
        '샘플 deck 복제는 설치된 PowerPoint를 win32com으로 구동하므로 Windows에서만 동작합니다. ' +
        `현재 플랫폼: ${process.platform}. (샘플 없이 만들면 python-pptx로 어디서든 생성됩니다.)`;
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
      // Sample present → clone it via PowerPoint COM; otherwise render a
      // consultant-style deck with python-pptx (cross-platform).
      const script = usingSample ? PPTX_BUILD_SCRIPT : CONSULTING_PPTX_SCRIPT;
      await fs.writeFile(tmpScript, script, 'utf-8');
      await fs.writeFile(
        tmpSpec,
        JSON.stringify({
          slides,
          sample_path: samplePath ?? null,
          style: this.params.style ?? 'consulting',
          footer: this.params.footer ?? null,
          accent: this.params.accent ?? null,
          primary: this.params.primary ?? null,
          font: this.params.font ?? null,
          font_kr: this.params.font_kr ?? null,
          aspect: this.params.aspect ?? null,
          slide_width_in: this.params.slide_width_in ?? null,
          slide_height_in: this.params.slide_height_in ?? null,
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
        : 'Sample used: NO — no sample_path was provided, so this deck used the DEFAULT template, NOT any reference deck.';

      // When no sample_path was given, prepend a loud, actionable warning at the
      // TOP of llmContent. The most common bug is the user pointing at / @-mentioning
      // a reference deck (which the model then merely *reads*) without that path being
      // forwarded as sample_path — reading extracts text but does NOT carry the design.
      // Make the model self-correct by re-calling with sample_path.
      const missingSampleWarning = samplePath
        ? ''
        : '⚠️ ACTION REQUIRED — This deck did NOT match any reference design; it used the built-in default template.\n' +
          'If the user pointed at, attached, or @-mentioned an existing deck to match (even one you already read for reference), ' +
          'that was the design source and you OMITTED it. Reading a deck only extracts its text — it does NOT apply its design. ' +
          'To actually match the reference, RE-CALL create_pptx now with `sample_path` set to that exact file path ' +
          '(keep the same `slides`). Tell the user the first deck used the default template and you are regenerating with the reference design.\n\n';

      return {
        llmContent:
          missingSampleWarning +
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
 * Parse a value that is expected to be an array/object but may have arrived as
 * a JSON *string*. Some in-house / non-OpenAI tool-calling models serialize
 * structured arguments as strings (e.g. `slides: "[{...}]"`), which trips JSON
 * schema validation ("params/slides must be array") and the call never runs.
 * Returns the parsed value when the string looks like JSON and parses cleanly;
 * otherwise returns the value unchanged so the validator reports the real issue.
 */
function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!(trimmed.startsWith('[') || trimmed.startsWith('{'))) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

/** True for plain objects (not null, not arrays). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse the listed keys in-place when they arrived as JSON-string arrays. */
function coerceArrayFields(
  obj: Record<string, unknown>,
  keys: readonly string[],
): void {
  for (const key of keys) {
    if (!(key in obj)) continue;
    const parsed = parseMaybeJson(obj[key]);
    if (Array.isArray(parsed)) obj[key] = parsed;
  }
}

/** Normalize one body block, parsing any string-encoded array fields. */
function coerceBlock(block: unknown): unknown {
  const parsed = parseMaybeJson(block);
  if (!isRecord(parsed)) return parsed;
  const b: Record<string, unknown> = { ...parsed };
  coerceArrayFields(b, ['items', 'columns', 'rows', 'steps', 'events']);
  return b;
}

/** Normalize one slide, parsing string-encoded body/bullets/table fields. */
function coerceSlide(slide: unknown): unknown {
  const parsed = parseMaybeJson(slide);
  if (!isRecord(parsed)) return parsed;
  const s: Record<string, unknown> = { ...parsed };
  coerceArrayFields(s, [
    'bullets',
    'bullets_right',
    'table',
    'regions',
    'placeholders',
  ]);
  const body = parseMaybeJson(s['body']);
  if (Array.isArray(body)) s['body'] = body.map(coerceBlock);
  const regions = parseMaybeJson(s['regions']);
  if (Array.isArray(regions)) {
    s['regions'] = regions.map((r) => {
      const rr = parseMaybeJson(r);
      if (!isRecord(rr)) return rr;
      const out: Record<string, unknown> = { ...rr };
      coerceArrayFields(out, ['bullets']);
      return out;
    });
  }
  const placeholders = parseMaybeJson(s['placeholders']);
  if (Array.isArray(placeholders)) {
    s['placeholders'] = placeholders.map((p) => {
      const pp = parseMaybeJson(p);
      if (!isRecord(pp)) return pp;
      const out: Record<string, unknown> = { ...pp };
      coerceArrayFields(out, ['bullets']);
      return out;
    });
  }
  return s;
}

/**
 * Best-effort repair of tool-call params from models that JSON-stringify
 * structured arguments. Turns a stringified `slides` array (or a single slide
 * object) back into a real array of slides so the call validates and runs. See
 * {@link parseMaybeJson}. Anything already well-formed passes through untouched.
 */
function coerceCreatePptxParams(params: CreatePptxParams): CreatePptxParams {
  if (!isRecord(params)) return params;
  const next: Record<string, unknown> = { ...params };
  const slides = parseMaybeJson(next['slides']);
  if (Array.isArray(slides)) {
    next['slides'] = slides.map(coerceSlide);
  } else if (isRecord(slides)) {
    // A lone slide object instead of an array — wrap it.
    next['slides'] = [coerceSlide(slides)];
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return next as unknown as CreatePptxParams;
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
        'list of "slides".\n\n' +
        'WITHOUT a sample (the usual case): a built-in CONSULTANT-STYLE deck is rendered with ' +
        'python-pptx (works everywhere, no PowerPoint needed). To make it genuinely good, write ' +
        'like a strategy consultant: (1) every content slide\'s "title" is an ACTION TITLE — a ' +
        'full-sentence takeaway, not a topic label; (2) build the slide from "body" blocks ' +
        '(kpis = big stat cards, columns = labeled comparison columns, callout = highlighted ' +
        'insight, bullets, table, text, and SHAPE/ICON INFOGRAPHICS: process = icon/numbered ' +
        'step flow with arrows via `steps`, timeline = horizontal roadmap via `events`) instead ' +
        'of one long bullet list; prefer process/timeline over bullets when showing a sequence, ' +
        'workflow, phases, or roadmap, and set an `icon` (e.g. "search", "people", "globe", ' +
        '"check") on each step/event for a designed look; (3) add a one-line ' +
        '"takeaway" (so-what) per slide; (4) open with a layout="title" cover and use ' +
        'layout="section" dividers between parts. Optional brand colors via "primary"/"accent" ' +
        '(hex), and a "footer" label.\n\n' +
        'TO MATCH AN EXISTING IN-HOUSE DECK: pass its path as "sample_path" and provide your ' +
        'content as slides. The tool opens the template through PowerPoint (DRM-protected in-house ' +
        "files work) and, per slide, ADDS A FRESH SLIDE BUILT FROM THE TEMPLATE'S OWN LAYOUT (slide " +
        'master) and fills its placeholders — the new slide inherits the template background, logo, ' +
        'fonts and bullet styles. BEST RESULT: FIRST call analyze_pptx_template to get ' +
        'style_guide.available_layouts (the menu of addable slide types, each with placeholders ' +
        'carrying an idx/role/name/bbox); then, per slide, set "layout_name" to pick the slide ' +
        'TYPE (VARY it — do not repeat one layout) and "placeholders":[{idx,text|bullets}] to put ' +
        'each piece of content into its OWN region (title placeholder gets the title, body/heading ' +
        'placeholders get their text) so nothing piles into one box. Without layout_name/' +
        'placeholders the tool falls back to a logical-layout heuristic and generic placeholder ' +
        'fill. It does NOT clone/text-replace the example slides by default (that was brittle). ' +
        '(DRM blocks python-pptx from reading the file, so this path runs through PowerPoint and is ' +
        'Windows-only.)\n\n' +
        'ADVANCED: for an EXACT 1:1 clone of a specific example slide, set mode="reuse" + ' +
        'sample_slide_index (optionally "regions" from analyze_pptx_template to place text by ' +
        'region id). For a python-pptx rebuild WITHOUT the file (no PowerPoint), call ' +
        'analyze_pptx_template for a style_guide and pass its suggested primary/accent/font/' +
        'font_kr/aspect here with NO sample_path.\n\n' +
        'The deck is saved (default under <workspace>/openrnd-ppt/) and opened.',
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
                    'content',
                    'bullets',
                    'two_col',
                    'table',
                    'image',
                    'blank',
                  ],
                  description:
                    "Logical layout: 'title' (cover), 'section' (divider), 'content' " +
                    "(action title + body blocks; the main consulting layout), 'bullets', " +
                    "'two_col', 'table', 'image', or 'blank'. Default: 'bullets'.",
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
                title: {
                  type: 'string',
                  description:
                    'Slide title. For content slides write an ACTION TITLE — a full-sentence ' +
                    'takeaway (e.g. "매출은 전년 대비 12% 성장하며 목표를 초과 달성했다"), not a ' +
                    'topic label (e.g. "매출 현황"). This drives the consultant feel.',
                },
                subtitle: {
                  type: 'string',
                  description:
                    'Subtitle / lead text (title & section layouts).',
                },
                body: {
                  type: 'array',
                  description:
                    'Rich content blocks rendered top-to-bottom (preferred over plain `bullets` ' +
                    'for a professional layout). Mix block types to design the slide.',
                  items: {
                    type: 'object',
                    properties: {
                      type: {
                        type: 'string',
                        enum: [
                          'bullets',
                          'columns',
                          'kpis',
                          'callout',
                          'table',
                          'text',
                          'process',
                          'timeline',
                        ],
                        description:
                          "'bullets' (bullet list), 'columns' (2-3 labeled columns), 'kpis' " +
                          "(big stat cards: value + label), 'callout' (highlighted insight), " +
                          "'table' (rows; first row = header), 'text' (paragraph), 'process' " +
                          "(icon/numbered step flow with arrows — use `steps`), 'timeline' " +
                          '(horizontal roadmap of milestones — use `events`). process/timeline ' +
                          'are shape-and-icon infographics (no charts) that make the deck look ' +
                          'professionally designed.',
                      },
                      items: {
                        type: 'array',
                        description:
                          "For 'bullets': string lines. For 'kpis': objects { value, label }.",
                        items: {},
                      },
                      steps: {
                        type: 'array',
                        description:
                          "For 'process': ordered steps drawn as a chevron/arrow flow. Each: " +
                          '{ title, text?, icon? }. Best with 2-6 steps.',
                        items: {
                          type: 'object',
                          properties: {
                            title: { type: 'string' },
                            text: { type: 'string' },
                            icon: {
                              type: 'string',
                              description:
                                'Semantic icon name shown in an accent circle, e.g. "search", ' +
                                '"people", "settings", "globe", "check", "star", "document", ' +
                                '"warning", "lock", "mail". Unknown names fall back to the step number.',
                            },
                          },
                          required: ['title'],
                        },
                      },
                      events: {
                        type: 'array',
                        description:
                          "For 'timeline': ordered milestones on a horizontal roadmap. Each: " +
                          '{ label, title, text?, icon? } where `label` is the date/phase shown ' +
                          'above the marker (e.g. "1분기").',
                        items: {
                          type: 'object',
                          properties: {
                            label: { type: 'string' },
                            title: { type: 'string' },
                            text: { type: 'string' },
                            icon: {
                              type: 'string',
                              description:
                                'Semantic icon name shown in the marker (e.g. "flag", "check", ' +
                                '"launch"). Omit for a plain dot marker.',
                            },
                          },
                          required: ['title'],
                        },
                      },
                      columns: {
                        type: 'array',
                        description:
                          "For 'columns': each column { heading?, bullets[] }.",
                        items: {
                          type: 'object',
                          properties: {
                            heading: { type: 'string' },
                            bullets: {
                              type: 'array',
                              items: { type: 'string' },
                            },
                          },
                        },
                      },
                      rows: {
                        type: 'array',
                        description:
                          "For 'table': rows of string cells (first row = header).",
                        items: { type: 'array', items: { type: 'string' } },
                      },
                      text: {
                        type: 'string',
                        description:
                          "For 'callout' / 'text': the text content.",
                      },
                    },
                    required: ['type'],
                  },
                },
                takeaway: {
                  type: 'string',
                  description:
                    'One-line "so-what" shown in a highlighted bar at the bottom of the slide.',
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
                regions: {
                  type: 'array',
                  description:
                    'Region-addressed content for a cloned SAMPLE slide (use with sample_path + ' +
                    'mode "reuse"/"auto", after analyze_pptx_template). Each entry fills one text ' +
                    'region of the chosen sample slide by its structural-path id. All original text ' +
                    'on the cloned slide is cleared first; omitted regions are left blank while the ' +
                    'design is preserved. Ignored without a sample.',
                  items: {
                    type: 'object',
                    properties: {
                      id: {
                        type: 'string',
                        description:
                          'Structural-path id of the target text region as returned by ' +
                          'analyze_pptx_template (e.g. "3", "3.2", "5.r2c1").',
                      },
                      text: {
                        type: 'string',
                        description: 'Plain text to place in the region.',
                      },
                      bullets: {
                        type: 'array',
                        items: { type: 'string' },
                        description:
                          'Bullet lines to place in the region (takes precedence over `text`).',
                      },
                    },
                    required: ['id'],
                  },
                },
                layout_name: {
                  type: 'string',
                  description:
                    'Name of the template CustomLayout to ADD for this slide — copy a `name` from ' +
                    'analyze_pptx_template style_guide.available_layouts. Picks the slide TYPE; ' +
                    'VARY it across slides to use the right layouts instead of repeating one. ' +
                    'With sample_path only; falls back to `layout` if the name is not found.',
                },
                layout_index: {
                  type: 'number',
                  description:
                    '1-based index of the template CustomLayout to add (fallback for layout_name; ' +
                    'matches available_layouts[].index). With sample_path only.',
                },
                placeholders: {
                  type: 'array',
                  description:
                    "Fill the added template slide's placeholders BY idx (use with sample_path, " +
                    'after analyze_pptx_template). Each entry targets one placeholder of the chosen ' +
                    'layout by its `idx` (from available_layouts[].placeholders) — put the title in ' +
                    'the title placeholder, headings/body text in their own placeholders, so ' +
                    'content lands in the right region instead of all in one box. Ignored without a sample.',
                  items: {
                    type: 'object',
                    properties: {
                      idx: {
                        type: 'number',
                        description:
                          'PlaceholderFormat idx of the target placeholder, from ' +
                          'available_layouts[].placeholders[].idx.',
                      },
                      text: {
                        type: 'string',
                        description: 'Plain text to place in the placeholder.',
                      },
                      bullets: {
                        type: 'array',
                        items: { type: 'string' },
                        description:
                          'Bullet lines to place in the placeholder (takes precedence over `text`).',
                      },
                    },
                    required: ['idx'],
                  },
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
          primary: {
            type: 'string',
            description:
              'Optional brand primary color as a hex string (e.g. "1F3864") for the consulting ' +
              'style. Defaults to a navy.',
          },
          accent: {
            type: 'string',
            description:
              'Optional brand accent color as a hex string (e.g. "2E75B6") for the consulting ' +
              'style. Defaults to a blue.',
          },
          font: {
            type: 'string',
            description:
              'Latin/heading font for the consulting style — pass style_guide.suggested.font ' +
              'from analyze_pptx_template to match a template. Defaults to "Calibri". No sample.',
          },
          font_kr: {
            type: 'string',
            description:
              'East-Asian (Korean) font for the consulting style — pass ' +
              'style_guide.suggested.font_kr to match a template. Defaults to "맑은 고딕". No sample.',
          },
          aspect: {
            type: 'string',
            enum: ['16:9', '4:3'],
            description:
              "Slide aspect for the consulting style: '16:9' (default) or '4:3'. Pass the " +
              "template's slide_size.aspect from analyze_pptx_template.",
          },
          slide_width_in: {
            type: 'number',
            description: 'Explicit slide width in inches (overrides `aspect`).',
          },
          slide_height_in: {
            type: 'number',
            description:
              'Explicit slide height in inches (overrides `aspect`).',
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

  /**
   * Repair string-encoded arguments (notably a JSON-stringified `slides`) before
   * the normal validate-then-build path, so models that serialize structured
   * tool args as strings don't fail with "params/slides must be array".
   */
  override build(
    params: CreatePptxParams,
  ): ToolInvocation<CreatePptxParams, ToolResult> {
    return super.build(coerceCreatePptxParams(params));
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
