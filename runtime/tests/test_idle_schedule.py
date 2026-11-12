import unittest
from datetime import datetime

from runtime.idle_schedule import (
    countdown_text,
    format_remaining,
    next_target,
    parse_targets,
)


class IdleScheduleTests(unittest.TestCase):
    def test_defaults_are_the_two_market_targets(self) -> None:
        self.assertEqual(parse_targets(None), [(9, 30, "开盘"), (15, 30, "收盘")])

    def test_custom_and_invalid_targets(self) -> None:
        self.assertEqual(
            parse_targets("09:30 开盘, 15:30 收盘, 17:00 下班"),
            [(9, 30, "开盘"), (15, 30, "收盘"), (17, 0, "下班")],
        )
        self.assertEqual(parse_targets(""), [])
        self.assertEqual(parse_targets("25:00 坏"), [(9, 30, "开盘"), (15, 30, "收盘")])

    def test_next_target_rolls_to_tomorrow(self) -> None:
        targets = parse_targets("09:30 开盘, 15:30 收盘")
        at = datetime(2026, 11, 12, 16, 0)
        target, label = next_target(targets, at)
        self.assertEqual(label, "开盘")
        self.assertEqual(target, datetime(2026, 11, 13, 9, 30))
        at = datetime(2026, 11, 12, 9, 0)
        target, label = next_target(targets, at)
        self.assertEqual(label, "开盘")
        self.assertEqual(target, datetime(2026, 11, 12, 9, 30))

    def test_format_and_countdown_line(self) -> None:
        self.assertEqual(format_remaining(3661), "1:01:01")
        self.assertEqual(format_remaining(59.2), "01:00")
        self.assertEqual(countdown_text("开盘", 59), "开盘倒计时 00:59")


if __name__ == "__main__":
    unittest.main()
