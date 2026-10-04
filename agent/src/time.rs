//! Wall-clock time in protocol units (integer milliseconds since the epoch), and how it is shown to people.

use std::time::{SystemTime, UNIX_EPOCH};

pub const SECOND_MS: i64 = 1_000;
pub const MINUTE_MS: i64 = 60 * SECOND_MS;
pub const HOUR_MS: i64 = 60 * MINUTE_MS;
pub const DAY_MS: i64 = 24 * HOUR_MS;

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// `2026-10-04T00:00:00Z`. Written out here (Howard Hinnant's civil-from-days) rather than pulling in a date
/// crate for one format string.
pub fn fmt_utc(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// "3 min ago", "in 40 s": for status lines, where an absolute time makes people do arithmetic.
pub fn fmt_relative(now: i64, then: i64) -> String {
    let d = (now - then).abs();
    let amount = if d < MINUTE_MS {
        format!("{} s", d / SECOND_MS)
    } else if d < HOUR_MS {
        format!("{} min", d / MINUTE_MS)
    } else if d < DAY_MS {
        format!("{} h", d / HOUR_MS)
    } else {
        format!("{} d", d / DAY_MS)
    };
    if then <= now {
        format!("{amount} ago")
    } else {
        format!("in {amount}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_utc() {
        assert_eq!(fmt_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(fmt_utc(1_791_072_000_000), "2026-10-04T00:00:00Z");
        assert_eq!(fmt_utc(951_782_400_000), "2000-02-29T00:00:00Z");
        assert_eq!(fmt_utc(1_791_071_999_999), "2026-10-03T23:59:59Z");
    }

    #[test]
    fn formats_relative() {
        assert_eq!(fmt_relative(10 * MINUTE_MS, 7 * MINUTE_MS), "3 min ago");
        assert_eq!(fmt_relative(0, 40 * SECOND_MS), "in 40 s");
        assert_eq!(fmt_relative(2 * DAY_MS, 0), "2 d ago");
    }
}
