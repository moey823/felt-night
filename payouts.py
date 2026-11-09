"""Whole-dollar presentation/allocation without changing legacy stored ledgers."""
def whole_dollar_awards(rows, pool_cents):
    result = [dict(row) for row in rows]
    if (not result or type(pool_cents) is not int or pool_cents < 0 or pool_cents % 100
            or any(type(row.get("award_cents")) is not int or row["award_cents"] < 0 for row in result)):
        return result
    total = sum(row["award_cents"] for row in result)
    if total == 0:
        best = min(range(len(result)), key=lambda i: (result[i].get("place") if type(result[i].get("place")) is int else 10**9, str(result[i].get("player_id", ""))))
        for i, row in enumerate(result):
            row["award_cents"] = pool_cents if i == best else 0
        return result
    dollars = pool_cents // 100
    allocations = [divmod(row["award_cents"] * dollars, total) for row in result]
    left = dollars - sum(amount for amount, _ in allocations)
    order = sorted(range(len(result)), key=lambda i: (-allocations[i][1],
        result[i].get("place") if type(result[i].get("place")) is int else 10**9,
        str(result[i].get("player_id", ""))))
    extras = set(order[:left])
    for i, row in enumerate(result):
        row["award_cents"] = (allocations[i][0] + (i in extras)) * 100
    return result


def rounded_tournament(tournament):
    """Normalize saved completed-game views consistently across all result lists."""
    result = dict(tournament)
    rows = result.get("results") or []
    if result.get("status") != "completed" or not rows:
        return result
    prize = result.get("prize") or {}
    pool = prize.get("pool_cents")
    if pool is None and all(type(row.get("award_cents")) is int for row in rows):
        pool = sum(row["award_cents"] for row in rows)
    rounded = whole_dollar_awards(rows, pool)
    awards = {row.get("player_id"):row["award_cents"] for row in rounded if "award_cents" in row}
    result["results"] = rounded
    for key in ("standings", "participants"):
        if key in result:
            result[key] = [dict(row, award_cents=awards[row.get("player_id")]) if row.get("player_id") in awards
                           else dict(row) for row in result[key]]
    return result
