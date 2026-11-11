"""Custom bubble renderer for the BigFish native helper.

The host owns the bubble spec (themes, scenes, modules, click lines). This
module turns one scene + one data snapshot into pixels with the same code the
editor previews offscreen, so "preview" and "desktop pet" cannot drift apart.

It intentionally supports a closed module set (text, icon, image, tasks,
divider, spacer, stock, bar) instead of HTML/CSS: Qt paints every module, and
the spec validator on the host rejects anything else.
"""

from __future__ import annotations

import re
from typing import Any

from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import (
    QColor,
    QFont,
    QFontMetrics,
    QImage,
    QPainter,
    QPainterPath,
    QPen,
    QPixmap,
)

STATE_COLORS = {
    "SUCCESS": ("#D9F7E4", "#12B85A"),
    "ERROR": ("#FDE3E3", "#E5484D"),
    "WAITING": ("#FFF0CE", "#D88A00"),
    "THINKING": ("#E2ECFF", "#4C78E8"),
    "WORKING": ("#DDEBFF", "#3478F6"),
    "DISCONNECTED": ("#ECEEF1", "#7B818A"),
}

STATE_LABELS = {
    "IDLE": "空闲",
    "THINKING": "思考中",
    "WORKING": "工作中",
    "WAITING": "等待确认",
    "SUCCESS": "完成",
    "ERROR": "错误",
    "DISCONNECTED": "未连接",
}

_TOKEN_RE = re.compile(r"[A-Za-z0-9_\-./:%]+|\s+|.", re.UNICODE)


def _hex_color(value: str, fallback: QColor) -> QColor:
    text = str(value or "").strip()
    if not text or text == "transparent":
        return QColor(0, 0, 0, 0)
    if len(text) == 7:
        color = QColor(text)
        return color if color.isValid() else fallback
    if len(text) == 9:
        try:
            return QColor(
                int(text[1:3], 16), int(text[3:5], 16), int(text[5:7], 16), int(text[7:9], 16)
            )
        except ValueError:
            return fallback
    return fallback


def resolve_color(value: str, theme: dict[str, Any]) -> QColor:
    token = str(value or "text")
    if token in {"text", "muted", "accent"}:
        return _hex_color(theme.get(token, "#25282D"), QColor("#25282D"))
    return _hex_color(token, _hex_color(theme.get("text", "#25282D"), QColor("#25282D")))


def _font(theme: dict[str, Any], size: float, scale: float, bold: bool = False, italic: bool = False) -> QFont:
    font = QFont(str(theme.get("font") or "Microsoft YaHei UI"))
    font.setPointSizeF(max(4.0, float(size) * scale))
    font.setBold(bool(bold))
    font.setItalic(bool(italic))
    return font


def _metrics(font: QFont) -> QFontMetrics:
    return QFontMetrics(font)


def _wrap(text: str, font: QFont, width: float, max_lines: int) -> list[str]:
    value = str(text or "").replace("\r", " ").strip()
    if not value:
        return []
    metrics = _metrics(font)
    limit = max(12.0, float(width))
    lines: list[str] = []
    current = ""
    for token in _TOKEN_RE.findall(value):
        if token == "\n":
            token = " "
        candidate = current + token
        if metrics.horizontalAdvance(candidate) <= limit or not current:
            current = candidate
            if metrics.horizontalAdvance(current) > limit and len(current) > 1:
                # A single very long token: hard-break it.
                while metrics.horizontalAdvance(current) > limit and len(current) > 1:
                    cut = max(1, len(current) // 2)
                    lines.append(current[:cut])
                    current = current[cut:]
            continue
        lines.append(current.rstrip())
        current = token.lstrip()
        if len(lines) >= max_lines:
            break
    if current and len(lines) < max_lines:
        lines.append(current.rstrip())
    if len(lines) > max_lines:
        lines = lines[:max_lines]
    if lines and max_lines > 0 and len(lines) >= max_lines:
        last = lines[-1]
        # Only elide when there is actually remaining text; the caller stores
        # the full string in `text`, so compare its length with the rendered.
        if len("".join(lines)) < len(value):
            lines[-1] = metrics.elidedText(last, Qt.TextElideMode.ElideRight, int(limit))
    return lines


def _line_height(font: QFont) -> float:
    return float(_metrics(font).height())


def _module_text(module: dict[str, Any], data: dict[str, Any]) -> str:
    field = module.get("field")
    if field == "text":
        return str(module.get("text") or "")
    value = data.get(field or "", "")
    if value is None:
        return ""
    return str(value)


def _task_rows(tasks: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    return (tasks or [])[:limit]


class BubbleRenderer:
    def __init__(self, spec: dict[str, Any], label_map: dict[str, str] | None = None):
        self.spec = spec if isinstance(spec, dict) else {}
        self.theme = self.spec.get("theme") or {}
        self.scenes = self.spec.get("scenes") or {}
        self.bindings = self.spec.get("bindings") or {}
        self.labels = label_map or STATE_LABELS
        self._image_cache: dict[str, QPixmap] = {}

    # ---- scene selection -------------------------------------------------
    def scene_for(self, data: dict[str, Any]) -> str:
        if data.get("scene"):
            return str(data["scene"])
        state = str(data.get("state") or "IDLE")
        if len(data.get("tasks") or []) >= 2:
            return str(self.bindings.get("MULTI_TASK") or self.bindings.get(state) or "status")
        return str(self.bindings.get(state) or self.bindings.get("IDLE") or "status")

    def scene(self, name: str) -> dict[str, Any]:
        return (self.scenes.get(name) or self.scenes.get("status") or {"rows": []})

    # ---- geometry --------------------------------------------------------
    def _font_for_module(self, module: dict[str, Any], scale: float, default_size: float) -> QFont:
        return _font(
            self.theme,
            float(module.get("size") or default_size),
            scale,
            bold=bool(module.get("bold")),
            italic=bool(module.get("italic")),
        )

    def _image_for(self, module: dict[str, Any], data: dict[str, Any], scale: float) -> tuple[QPixmap | None, float, float]:
        pixmap = data.get("memePixmap")
        if not isinstance(pixmap, QPixmap) or pixmap.isNull():
            path = str(data.get("memePath") or "")
            pixmap = self._image_cache.get(path) if path else None
            if pixmap is None and path:
                pixmap = QPixmap(path)
                if not pixmap.isNull():
                    self._image_cache[path] = pixmap
        if not isinstance(pixmap, QPixmap) or pixmap.isNull():
            return None, 0.0, 0.0
        max_w = float(module.get("maxWidth") or 300) * scale
        max_h = float(module.get("maxHeight") or 300) * scale
        width = float(pixmap.width())
        height = float(pixmap.height())
        factor = min(1.0, max_w / width if width else 1.0, max_h / height if height else 1.0)
        return pixmap, max(1.0, width * factor), max(1.0, height * factor)

    def _module_size(self, module: dict[str, Any], width: float, data: dict[str, Any], scale: float) -> tuple[float, float]:
        kind = module.get("type")
        if kind == "icon":
            size = float(module.get("size") or 46) * scale
            return size, size
        if kind == "image":
            _, w, h = self._image_for(module, data, scale)
            return w, h
        if kind == "divider":
            return width, 1.0 * scale
        if kind == "spacer":
            return 0.0, 0.0
        if kind == "tasks":
            font = self._font_for_module(module, scale, 9)
            limit = int(module.get("max") or 3)
            rows = _task_rows(data.get("tasks") or [], limit)
            extra = 1 if len(data.get("tasks") or []) > limit else 0
            height = (len(rows) + extra) * _line_height(font) * 1.45 if rows else _line_height(font)
            return width, height
        if kind == "text":
            font = self._font_for_module(module, scale, 9)
            text = _module_text(module, data)
            lines = _wrap(text, font, width, int(module.get("maxLines") or 2))
            return width, max(_line_height(font), len(lines) * _line_height(font) * 1.35)
        # stock / bar
        font = self._font_for_module(module, scale, 9)
        return width, _line_height(font) * 1.5

    def _row_layout(self, row: dict[str, Any], inner_width: float, data: dict[str, Any], scale: float) -> list[tuple[dict[str, Any], float, float, float]]:
        modules = list(row.get("modules") or [])
        if not modules:
            return []
        gap = float(row.get("gap") or 8) * scale
        total_gap = gap * max(0, len(modules) - 1)
        available = max(0.0, inner_width - total_gap)
        fixed = 0.0
        flexible: list[dict[str, Any]] = []
        for module in modules:
            kind = module.get("type")
            if kind in {"icon", "image", "divider"}:
                w, _ = self._module_size(module, available, data, scale)
                fixed += w
            elif kind == "spacer":
                flexible.append(module)
            else:
                flexible.append(module)
        remaining = max(0.0, available - fixed)
        weights = sum(float(module.get("weight") or 1.0) for module in flexible) or 1.0
        layout: list[tuple[dict[str, Any], float, float, float]] = []
        x = 0.0
        for module in modules:
            kind = module.get("type")
            if kind == "spacer":
                width = remaining * (float(module.get("weight") or 1.0) / weights)
            elif kind in {"icon", "image", "divider"}:
                width, _ = self._module_size(module, available, data, scale)
            else:
                width = remaining * (float(module.get("weight") or 1.0) / weights)
            width = max(0.0, width)
            _, height = self._module_size(module, width, data, scale)
            layout.append((module, x, width, height))
            x += width + gap
        return layout

    def measure(self, scene_name: str, data: dict[str, Any], scale: float = 1.0) -> tuple[int, int]:
        scene = self.scene(scene_name)
        width = float(self.theme.get("width") or 420) * scale
        padding = float(self.theme.get("padding") or 18) * scale
        inner = max(20.0, width - padding * 2)
        height = padding * 2
        rows = list(scene.get("rows") or [])
        for index, row in enumerate(rows):
            layout = self._row_layout(row, inner, data, scale)
            row_height = max((item[3] for item in layout), default=0.0)
            height += row_height
            if index < len(rows) - 1:
                height += float(row.get("gap") or 8) * scale
        return int(round(width)), int(round(max(64.0 * scale, height)))

    # ---- painting --------------------------------------------------------
    def paint(self, painter: QPainter, rect: QRectF, scene_name: str, data: dict[str, Any], scale: float = 1.0) -> None:
        scene = self.scene(scene_name)
        width = rect.width()
        height = rect.height()
        padding = float(self.theme.get("padding") or 18) * scale
        radius = float(self.theme.get("radius") or 30) * scale
        opacity = float(self.theme.get("opacity") or 1.0)
        background = resolve_color(self.theme.get("background", "#FCFCFD"), self.theme)
        border = resolve_color(self.theme.get("border", "#DADDE2"), self.theme)
        border_width = float(self.theme.get("borderWidth") or 1) * scale

        painter.save()
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        painter.setOpacity(max(0.2, min(1.0, opacity)))
        if self.theme.get("shadow", True):
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(QColor(17, 24, 39, 18))
            painter.drawRoundedRect(rect.translated(0, 5 * scale), radius, radius)
        painter.setPen(QPen(border, border_width) if border_width > 0 else Qt.PenStyle.NoPen)
        painter.setBrush(background)
        painter.drawRoundedRect(rect, radius, radius)
        painter.setOpacity(1.0)

        inner = rect.adjusted(padding, padding, -padding, -padding)
        y = inner.top()
        rows = list(scene.get("rows") or [])
        for index, row in enumerate(rows):
            layout = self._row_layout(row, inner.width(), data, scale)
            row_height = max((item[3] for item in layout), default=0.0)
            x = inner.left()
            for module, offset, module_width, module_height in layout:
                module_rect = QRectF(x + offset, y, module_width, module_height)
                self._paint_module(painter, module, module_rect, data, scale)
            y += row_height
            if index < len(rows) - 1:
                y += float(row.get("gap") or 8) * scale
        painter.restore()

    def _paint_module(self, painter: QPainter, module: dict[str, Any], rect: QRectF, data: dict[str, Any], scale: float) -> None:
        kind = module.get("type")
        align = module.get("align") or "left"
        if kind == "icon":
            self._paint_icon(painter, str(data.get("state") or "IDLE"), rect.center(), rect.width() / 2)
            return
        if kind == "image":
            pixmap, _, _ = self._image_for(module, data, scale)
            if pixmap is None:
                return
            target = QRectF(rect)
            factor = min(rect.width() / pixmap.width() if pixmap.width() else 1.0, rect.height() / pixmap.height() if pixmap.height() else 1.0)
            w = pixmap.width() * factor
            h = pixmap.height() * factor
            target = QRectF(rect.center().x() - w / 2, rect.top(), w, h)
            radius = float(module.get("radius") or 12) * scale
            path = QPainterPath()
            path.addRoundedRect(target, radius, radius)
            painter.save()
            painter.setClipPath(path)
            painter.drawPixmap(target.toRect(), pixmap)
            painter.restore()
            return
        if kind == "divider":
            painter.setPen(QPen(QColor(218, 221, 226, 180), max(1.0, scale)))
            y = rect.center().y()
            painter.drawLine(QPointF(rect.left(), y), QPointF(rect.right(), y))
            return
        if kind == "tasks":
            self._paint_tasks(painter, module, rect, data, scale)
            return
        if kind == "stock":
            self._paint_stock(painter, module, rect, data, scale)
            return
        if kind == "bar":
            self._paint_bar(painter, module, rect, data, scale)
            return
        if kind == "text":
            self._paint_text(painter, module, rect, data, scale, align)

    def _paint_text(self, painter: QPainter, module: dict[str, Any], rect: QRectF, data: dict[str, Any], scale: float, align: str) -> None:
        font = self._font_for_module(module, scale, float(self.theme.get("bodySize") or 9))
        color = resolve_color(module.get("color") or "text", self.theme)
        text = _module_text(module, data)
        if not text:
            return
        max_lines = int(module.get("maxLines") or 2)
        wrap = module.get("wrap", True)
        if not wrap:
            text = _metrics(font).elidedText(text, Qt.TextElideMode.ElideRight, int(rect.width()))
            lines = [text]
        else:
            lines = _wrap(text, font, rect.width(), max_lines)
        if not lines:
            return
        painter.setFont(font)
        painter.setPen(color)
        line_height = _line_height(font)
        y = rect.top()
        for line in lines:
            x = rect.left()
            width = rect.width()
            if align == "center":
                x = rect.center().x() - _metrics(font).horizontalAdvance(line) / 2
            elif align == "right":
                x = rect.right() - _metrics(font).horizontalAdvance(line)
            painter.drawText(QPointF(x, y + _metrics(font).ascent()), line)
            y += line_height * 1.35

    def _paint_tasks(self, painter: QPainter, module: dict[str, Any], rect: QRectF, data: dict[str, Any], scale: float) -> None:
        font = self._font_for_module(module, scale, 9)
        painter.setFont(font)
        line_height = _line_height(font) * 1.45
        tasks = _task_rows(data.get("tasks") or [], int(module.get("max") or 3))
        labels = data.get("labels") or self.labels
        y = rect.top()
        for task in tasks:
            state = str(task.get("state") or "IDLE")
            _, foreground = STATE_COLORS.get(state, ("#ECEEF1", "#747A84"))
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(QColor(foreground))
            painter.drawEllipse(QPointF(rect.left() + 4 * scale, y + line_height / 2 - 2 * scale), 3.5 * scale, 3.5 * scale)
            label = task.get("project") or task.get("task") or task.get("message") or labels.get(state, state)
            line = f"{labels.get(state, state)} · {label}"
            painter.setPen(QColor(str(self.theme.get("muted") or "#747981")))
            text = _metrics(font).elidedText(str(line), Qt.TextElideMode.ElideRight, max(20, int(rect.width() - 14 * scale)))
            painter.drawText(QPointF(rect.left() + 12 * scale, y + _metrics(font).ascent()), text)
            y += line_height
        if len(data.get("tasks") or []) > len(tasks):
            painter.setPen(QColor(str(self.theme.get("muted") or "#9AA0A6")))
            painter.drawText(QPointF(rect.left() + 12 * scale, y + _metrics(font).ascent()), f"还有 {len(data.get('tasks') or []) - len(tasks)} 个任务…")

    def _paint_stock(self, painter: QPainter, module: dict[str, Any], rect: QRectF, data: dict[str, Any], scale: float) -> None:
        stocks = data.get("stocks") or []
        index = int(module.get("index") or 0)
        if index >= len(stocks):
            return
        stock = stocks[index]
        font = self._font_for_module(module, scale, 9)
        painter.setFont(font)
        painter.setPen(resolve_color("text", self.theme))
        y = rect.top() + _metrics(font).ascent()
        name = str(stock.get("name") or stock.get("code") or "")
        price = stock.get("price")
        pct = stock.get("pct")
        parts = []
        if module.get("showName", True):
            parts.append(name)
        if module.get("showPrice", True) and isinstance(price, (int, float)):
            parts.append(f"{price:.2f}")
        if module.get("showPct", True) and isinstance(pct, (int, float)):
            parts.append(f"{pct:+.2f}%")
        painter.drawText(QPointF(rect.left(), y), "  ".join(parts))

    def _paint_bar(self, painter: QPainter, module: dict[str, Any], rect: QRectF, data: dict[str, Any], scale: float) -> None:
        percent = data.get("stockPercentile")
        if not isinstance(percent, (int, float)):
            return
        height = float(module.get("height") or 6) * scale
        track = QRectF(rect.left(), rect.center().y() - height / 2, rect.width(), height)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QColor(218, 221, 226, 160))
        painter.drawRoundedRect(track, height / 2, height / 2)
        filled = QRectF(track.left(), track.top(), track.width() * max(0.0, min(1.0, float(percent) / 100.0)), height)
        painter.setBrush(resolve_color("accent", self.theme))
        painter.drawRoundedRect(filled, height / 2, height / 2)

    def _paint_icon(self, painter: QPainter, state: str, center: QPointF, radius: float) -> None:
        background, foreground = STATE_COLORS.get(state, ("#ECEEF1", "#747A84"))
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QColor(background))
        painter.drawEllipse(center, radius, radius)
        pen = QPen(QColor(foreground), max(2.0, radius * 0.13))
        pen.setCapStyle(Qt.PenCapStyle.RoundCap)
        pen.setJoinStyle(Qt.PenJoinStyle.RoundJoin)
        painter.setPen(pen)
        painter.setBrush(Qt.BrushStyle.NoBrush)
        x, y = center.x(), center.y()
        if state == "SUCCESS":
            painter.drawLine(QPointF(x - radius * 0.32, y), QPointF(x - radius * 0.08, y + radius * 0.24))
            painter.drawLine(QPointF(x - radius * 0.08, y + radius * 0.24), QPointF(x + radius * 0.38, y - radius * 0.28))
        elif state == "ERROR":
            painter.drawLine(QPointF(x - radius * 0.25, y - radius * 0.25), QPointF(x + radius * 0.25, y + radius * 0.25))
            painter.drawLine(QPointF(x + radius * 0.25, y - radius * 0.25), QPointF(x - radius * 0.25, y + radius * 0.25))
        elif state == "WAITING":
            painter.drawLine(QPointF(x, y - radius * 0.35), QPointF(x, y + radius * 0.05))
            painter.setBrush(QColor(foreground))
            painter.drawEllipse(QPointF(x, y + radius * 0.32), radius * 0.08, radius * 0.08)
        elif state in {"THINKING", "WORKING"}:
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(QColor(foreground))
            for offset in (-radius * 0.3, 0, radius * 0.3):
                painter.drawEllipse(QPointF(x + offset, y), radius * 0.1, radius * 0.1)
        else:
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(QColor(foreground))
            painter.drawEllipse(center, radius * 0.18, radius * 0.18)


def render_preview(spec: dict[str, Any], scene: str, data: dict[str, Any], scale: float = 1.0) -> QImage:
    renderer = BubbleRenderer(spec)
    width, height = renderer.measure(scene, data, scale)
    image = QImage(max(1, width), max(1, height), QImage.Format.Format_ARGB32)
    image.fill(Qt.GlobalColor.transparent)
    painter = QPainter(image)
    try:
        renderer.paint(painter, QRectF(0, 0, width, height), scene, data, scale)
    finally:
        painter.end()
    return image
