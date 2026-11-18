#!/usr/bin/env python3
"""Generate server/web/domains/pcb/generated/kicad-menu-spec.json and kicad-menu-icons.json from KiCad's own sources.

The menu bar, the hotkey handling and Help > List Hotkeys need more of KiCad's TOOL_ACTIONs than the
toolbars use (gen_kicad_ui.py keeps only those): every action of the three action tables with its
friendly name, tooltip, icon name and default hotkey(s) — the Linux / Windows one, plus the macOS one where it
differs — keyed by its C++ name (kicad-menu-spec.json, which
the editor bundle reads for its key handling), plus the icons of the actions the menus in server/web/domains/pcb/tables.ts
list that the toolbar spec does not already carry (kicad-menu-icons.json, chrome bundle only).

Run from the repository root:  python3 server/scripts/gen_kicad_menus.py
"""
import json, os, re, sys

sys.path.insert(0, os.path.dirname(__file__))
import gen_kicad_ui as base  # noqa: E402

OUT = os.path.join(base.ROOT, "server", "web", "domains", "pcb", "generated", "kicad-menu-spec.json")
OUT_ICONS = os.path.join(base.ROOT, "server", "web", "domains", "pcb", "generated", "kicad-menu-icons.json")
UI_SPEC = os.path.join(base.ROOT, "server", "web", "domains", "pcb", "generated", "kicad-ui-spec.json")
TABLES = os.path.join(base.ROOT, "server", "web", "domains", "pcb", "tables.ts")
# Icons the menu chrome uses that belong to no action (sub-menu titles, the About box).
EXTRA_ICONS = {"import", "export_file", "fabrication", "language", "add_zone", "contrast_mode", "mw_add_line", "add_aligned_dimension",
               "measurement", "mode_module", "puzzle_piece", "swap", "locked", "show_ratsnest", "group", "component_select_unit",
               "special_tools", "align_items", "convert", "unit_mm", "checked_ok", "right", "text_align_left", "icon_kicad", "hotkeys", "about",
               # the Footprint Wizard frame's toolbar (editor/fpwizard.ts)
               "module_wizard", "reload", "refresh", "zoom_in", "zoom_out", "zoom_fit_in_page", "export_footprint_names",
               # Assign Footprints' toolbar (cvpcb/toolbars_cvpcb.cpp, dialogs/assign-footprints.ts)
               "module_filtered_list", "module_pin_filtered_list", "module_library_list", "delete_association", "show_footprint",
               "auto_associate", "left", "save", "undo", "redo", "library_table",
               # the Net Inspector pane's configure button (pcbnew/widgets/net_inspector_panel.cpp)
               "config",
               # Clarify Selection rows: the item icons of BOARD_ITEM::GetMenuImage with no action of their own
               "add_dashed_line", "show_mod_edge", "drc", "add_pcb_target", "grid_select", "add_point",
               # the browse buttons of the grid cell editors (common/widgets/grid_text_button_helpers.cpp)
               "small_library", "small_folder", "www",
               # the small bitmap buttons of grids and file fields (WX_GRID add / edit / move / delete)
               "small_plus", "small_trash", "small_up", "small_down", "small_edit", "small_refresh", "small_warning", "edit",
               # DIALOG_ABOUT's notebook images (dialog_about.cpp:63-71)
               "info", "recent", "preference", "editor", "library", "color_materials", "zip", "tools", "bug",
               # the Calculator Tools frame (pcb_calculator_frame.cpp)
               "calculator",
               # PANEL_COLOR_CODE's band pictures (panel_color_code.cpp ThemeChanged)
               "color_code_value_and_name", "color_code_value", "color_code_multiplier", "color_code_tolerance",
               # the Appearance pane: Nets / Net Classes heading buttons and the layer context menu
               # (pcbnew/widgets/appearance_controls.cpp), the property grid's category buttons
               # (common/widgets/properties_panel.cpp), the hierarchy tree's row icons (eeschema/widgets/hierarchy_pane.cpp)
               "list_nets", "options_generic", "show_all_copper_layers", "show_no_copper_layers", "show_all_layers", "show_no_layers",
               "show_front_assembly_layers", "show_all_front_layers", "show_all_back_layers", "show_back_assembly_layers",
               "tree_sel", "tree_nosel",
               # the Search pane's menu (common/widgets/search_pane.cpp)
               "zoom_center_on_screen",
               # the STD_BITMAP_BUTTONs of the dialog grids (library tables, 3D models, pin table, pad table, fields)
               "small_new_window",
               "small_sort_desc", "small_top", "small_bottom", "ercerr", "ercwarn", "text_bold", "text_italic", "text_valign_top",
               "text_valign_center", "text_valign_bottom", "text_mirrored", "options_3drender", "ortho", "axis3d_left", "axis3d_right", "axis3d_front", "axis3d_back",
               "axis3d_top", "axis3d_bottom", "show_board_body", "lib_previous", "lib_next", "search_tree", "list_nets_16",
               # PinTypeIcons, PinShapeIcons and PinOrientationIcons (eeschema/pin_type.cpp) for the pin dialogs' icon combos
               "pintype_input", "pintype_output", "pintype_bidi", "pintype_3states", "pintype_passive", "pintype_nic",
               "pintype_notspecif", "pintype_powerinput", "pintype_poweroutput", "pintype_opencoll", "pintype_openemit",
               "pintype_noconnect", "pinshape_normal", "pinshape_invert", "pinshape_clock_normal", "pinshape_clock_invert",
               "pinshape_active_low_input", "pinshape_clock_active_low", "pinshape_active_low_output", "pinshape_clock_fall",
               "pinshape_nonlogic", "pinorient_right", "pinorient_left", "pinorient_up", "pinorient_down",
               # dialog STD_BITMAP_BUTTONs (grid add / move / delete, browse, refresh) and the text formatting BITMAP_BUTTONs
               "text_align_center", "text_align_right", "text_align_top", "text_align_bottom",
               "text_horizontal", "text_vertical",
               "label_align_left", "label_align_right", "label_align_top", "label_align_bottom",
               # PINTYPE_COMBOBOX / PINSHAPE_COMBOBOX and the line style wxBitmapComboBoxes
               "stroke_solid", "stroke_dash", "stroke_dot", "stroke_dashdot", "stroke_dashdotdot", "stroke_none",
               # SIMULATOR_FRAME's toolbar and menus, TUNER_SLIDER
               "directory_open", "save_as", "sim_add_plot", "sim_command", "sim_run", "sim_stop", "zoom_in_horizontally",
               "zoom_out_horizontally", "zoom_in_vertically", "zoom_out_vertically", "sim_probe", "sim_tune", "sim_add_signal", "netlist",
               "export_png", "text", "copy", "e_24", "e_48", "e_96", "e_192",
               # SYMBOL_VIEWER_FRAME's toolbar
               "pin_show_etype", "pin", "datasheet", "add_symbol_to_schematic", "library_browser",
               # PANEL_EESCHEMA_ANNOTATION_OPTIONS' sort order bitmaps
               "annotate_down_right", "annotate_right_down",
               # the static bitmaps of the Board Setup pages (PANEL_SETUP_CONSTRAINTS, PANEL_SETUP_TEARDROPS,
               # PANEL_SETUP_TUNING_PATTERNS)
               "zone_fillet", "thermal_spokes", "ps_diff_pair_gap", "width_track", "width_conn", "via_annulus", "via_diameter",
               "via_hole_diameter", "hole_to_copper_clearance", "hole_to_hole_clearance", "edge_to_copper_clearance",
               "teardrop_sizes", "teardrop_rect_sizes", "teardrop_track_sizes", "tune_single_track_length_legend",
               "tune_diff_pair_length_legend", "tune_diff_pair_skew_legend", "drc", "locked", "net_highlight", "config",
               # STD_BITMAP_BUTTON / BITMAP_BUTTON bitmaps of the board dialogs (grid add / delete / move, browse, refresh, warning)
               # the selection menu's Shape Modification sub-menu (EDIT_TOOL, ctxmenus.ts), whose actions no menu bar lists
               "fillet", "chamfer", "merge_polygons", "subtract_polygons", "intersect_polygons",
               # wxArtProvider::GetBitmap( wxART_WARNING, wxART_CMN_DIALOG ): DIALOG_PLOT's solder mask alert
               "dialog_warning",
               # SYMBOL_EDIT_FRAME's File > Import / Export sub-menus (SCH_ACTIONS::importSymbol, exportSymbol)
               "import_part", "export_part"}


MAC_IF = r"#\s*if(?:def\s+|\s+defined\(\s*)__WX(?:OSX_)?MAC__[ \t]*\)?[^\n]*\n"


def platform_branch(s, mac):
    """Resolve the #if __WXMAC__ … #else … #endif blocks to one platform's branch."""
    s = re.sub(MAC_IF + r"(.*?)#\s*else[^\n]*\n(.*?)#\s*endif", lambda m: m.group(1 if mac else 2), s, flags=re.S)
    return re.sub(MAC_IF + r"(.*?)#\s*endif", lambda m: m.group(1) if mac else "", s, flags=re.S)


def fmt_hotkey(expr):
    """"MD_CTRL + MD_SHIFT + 'G'" → "Ctrl+Shift+G"; ' ' is Space, '\\\\' the backslash, '\\'' the apostrophe."""
    expr = expr.strip()
    if not expr or expr == "0":
        return None
    mods = [label for mod, label in (("MD_CTRL", "Ctrl"), ("MD_SHIFT", "Shift"), ("MD_ALT", "Alt")) if mod in expr]
    key = None
    m = re.search(r"'(\\.|[^'\\])'", expr)
    if m:
        c = m.group(1)
        c = c[1] if c.startswith("\\") else c
        key = "Space" if c == " " else c.upper() if c.isalpha() else c
    else:
        for k, v in base.KEYS.items():
            if re.search(r"\b" + k + r"\b", expr):
                key = v
                break
    return "+".join(mods + [key]) if key else None


def parse_actions(mac=False):
    """All TOOL_ACTIONs of one platform: {"CLS::name": {id, label, tip, icon, key, alt}}."""
    out = {}
    for src in base.ACTION_SOURCES:
        s = platform_branch(base.read(src), mac)
        for m in re.finditer(r"TOOL_ACTION\s+(\w+)::(\w+)\s*\(\s*TOOL_ACTION_ARGS\(\)(.*?)\)\s*;", s, re.S):
            cls, name, body = m.groups()

            def field(key):
                r = re.search(r"\." + key + r"\(\s*_?\(?\s*((?:\"(?:[^\"\\]|\\.)*\"\s*)+)", body)
                if not r:
                    return None
                return "".join(p.replace('\\"', '"') for p in re.findall(r"\"((?:[^\"\\]|\\.)*)\"", r.group(1)))

            icon = re.search(r"\.Icon\(\s*BITMAPS::(\w+)", body)
            hk = re.search(r"\.DefaultHotkey\(\s*([^)]*)\)", body)
            alt = re.search(r"\.DefaultHotkeyAlt\(\s*([^)]*)\)", body)
            label = field("FriendlyName")
            if not label:
                continue
            a = {"id": name, "label": label, "tip": field("Tooltip"), "icon": icon.group(1) if icon else None,
                 "key": fmt_hotkey(hk.group(1)) if hk else None}
            nm = re.search(r"\.Name\(\s*\"([^\"]+)\"", body)
            if nm:
                a["name"] = nm.group(1)   # the TOOL_ACTION name a user.hotkeys file keys its lines by
            if alt and fmt_hotkey(alt.group(1)):
                a["alt"] = fmt_hotkey(alt.group(1))
            out[f"{cls}::{name}"] = a
    return out


def all_actions():
    """The Linux / Windows table, each action carrying "mac" where the macOS default hotkey differs ("" = none there)."""
    actions, mac = parse_actions(False), parse_actions(True)
    for name, a in actions.items():
        m = mac.get(name)
        if m and m["key"] != a["key"]:
            a["mac"] = m["key"] or ""
    return actions


def main():
    actions = all_actions()
    with open(UI_SPEC, encoding="utf-8") as f:
        have = set(json.load(f)["icons"])
    with open(TABLES, encoding="utf-8") as f:
        t = f.read()
    menus = t[t.index("const COLLAB_FILE"):t.index("export const HOME_MENUS")]   # the shared File / Help blocks above MENUS too
    listed = set(re.findall(r"\"([A-Za-z0-9]+)(?:\|[^\"]*)?\"", menus))
    names = set(EXTRA_ICONS)
    for a in actions.values():
        if a["id"] in listed and a["icon"] and a["icon"] != "INVALID_BITMAP":
            names.add(a["icon"])
    icons = base.collect_icons(names - have)
    note = "server/scripts/gen_kicad_menus.py from KiCad's TOOL_ACTIONs and resources/bitmaps_png — do not edit by hand"
    for path, data in ((OUT, {"generated": note, "actions": actions}), (OUT_ICONS, {"generated": note, "icons": icons})):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, separators=(",", ":"), ensure_ascii=False)
            f.write("\n")
    print("actions:", len(actions), "icons:", len(icons), "bytes:", os.path.getsize(OUT), os.path.getsize(OUT_ICONS))


if __name__ == "__main__":
    main()
