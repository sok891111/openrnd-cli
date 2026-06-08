/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared Python (win32com) helpers embedded into BOTH the PowerPoint analyze
 * script (analyze-pptx.ts) and the build script (create-pptx.ts).
 *
 * The single most important property here is that `iter_text_regions(slide)`
 * walks a slide's shape tree in a STABLE, deterministic order and assigns each
 * text region a structural PATH id (e.g. "3", "3.2", "5.r2c1"). Because a slide
 * cloned via `Duplicate()` preserves its shape tree and order, running the SAME
 * iterator on the clone yields the SAME ids the analyze tool reported on the
 * original. That is what lets the model say "put this text in region 3.2" and
 * have it land in exactly the intended shape.
 *
 * The iterator recurses into groups (GroupItems) and tables (cells) — the thing
 * the old top-level-only walk missed, which left body text inside grouped /
 * tabular shapes neither cleared nor refilled. Embedding the identical source in
 * both scripts (rather than re-deriving the logic twice) keeps the id schemes in
 * lockstep; if they ever drift, region mapping silently breaks.
 */
export const PPTX_REGION_HELPERS = String.raw`# --- shared: deterministic recursive text-region iterator -------------------
# Walks a slide's shape tree in a STABLE order (top-level shapes, then group
# children depth-first, then table cells row-major) and yields
#   (region_id, shape_with_textframe, kind)
# where region_id is a structural PATH ("3", "3.2", "5.r2c1"). The SAME slide
# cloned via Duplicate() yields identical ids, so the analyze tool's ids match
# the build tool's ids. Used for analysis, clearing, and region-addressed fill.
msoGroup = 6


def _walk_text_regions(shapes, prefix):
    try:
        count = shapes.Count
    except Exception:
        return
    for i in range(1, count + 1):
        try:
            shp = shapes.Item(i)
        except Exception:
            continue
        rid = ("%s.%d" % (prefix, i)) if prefix else ("%d" % i)
        # Recurse into groups so nested text is reachable.
        try:
            is_group = (shp.Type == msoGroup)
        except Exception:
            is_group = False
        if is_group:
            try:
                for r in _walk_text_regions(shp.GroupItems, rid):
                    yield r
            except Exception:
                pass
            continue
        # Tables: yield each cell's shape (its TextFrame is writable).
        try:
            has_table = bool(shp.HasTable)
        except Exception:
            has_table = False
        if has_table:
            try:
                tbl = shp.Table
                rows = tbl.Rows.Count
                cols = tbl.Columns.Count
            except Exception:
                rows = cols = 0
            for r in range(1, rows + 1):
                for c in range(1, cols + 1):
                    try:
                        cell_shp = tbl.Cell(r, c).Shape
                    except Exception:
                        continue
                    yield ("%s.r%dc%d" % (rid, r, c), cell_shp, "table_cell")
            continue
        # Plain text-bearing shape (placeholder or textbox).
        try:
            if shp.HasTextFrame:
                yield (rid, shp, "shape")
        except Exception:
            pass


def iter_text_regions(slide):
    return _walk_text_regions(slide.Shapes, "")


def region_text(shp):
    try:
        if shp.TextFrame.HasText:
            return shp.TextFrame.TextRange.Text or ""
    except Exception:
        pass
    return ""


def clear_all_text(slide):
    """Blank EVERY text region on the slide (incl. group children and table
    cells), keeping the shapes themselves, so none of the sample's original
    wording lingers after a clone."""
    cleared = 0
    for _rid, shp, _kind in iter_text_regions(slide):
        try:
            if shp.TextFrame.HasText:
                shp.TextFrame.TextRange.Text = ""
                cleared += 1
        except Exception:
            pass
    return cleared
`;
