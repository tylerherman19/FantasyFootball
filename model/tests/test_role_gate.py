from model.export_projections import apply_weekly_role_gate, game_environment, role_play_probability


def test_explicit_qb2_has_no_weekly_projection_or_variance():
    stats, sd, active = apply_weekly_role_gate(
        "QB",
        {"pass_yd": 245.0, "pass_td": 1.6, "rush_yd": 31.0},
        7.9,
        has_team=True,
        roster_status="ACT",
        depth_rank=2,
    )

    assert stats == {"pass_yd": 0.0, "pass_td": 0.0, "rush_yd": 0.0}
    assert sd == 0.0
    assert active is False


def test_active_qb1_projection_is_unchanged():
    original = {"pass_yd": 245.0, "pass_td": 1.6}
    stats, sd, active = apply_weekly_role_gate(
        "QB", original, 7.9, has_team=True, roster_status="ACT", depth_rank=1
    )

    assert stats == original
    assert sd == 7.9
    assert active is True


def test_reserve_player_has_no_projection_even_if_listed_first():
    stats, sd, active = apply_weekly_role_gate(
        "QB", {"pass_yd": 245.0}, 7.9,
        has_team=True, roster_status="RES", depth_rank=1,
    )

    assert stats == {"pass_yd": 0.0}
    assert sd == 0.0
    assert active is False


def test_missing_depth_data_does_not_invent_a_backup_designation():
    stats, sd, active = apply_weekly_role_gate(
        "QB", {"pass_yd": 245.0}, 7.9,
        has_team=True, roster_status="ACT", depth_rank=None,
    )

    assert stats == {"pass_yd": 245.0}
    assert sd == 7.9
    assert active is True


def test_unranked_qb_is_suppressed_when_his_team_has_an_explicit_qb1():
    stats, sd, active = apply_weekly_role_gate(
        "QB", {"pass_yd": 245.0}, 7.9,
        has_team=True, roster_status="ACT", depth_rank=None, team_has_qb1=True,
    )

    assert stats == {"pass_yd": 0.0}
    assert sd == 0.0
    assert active is False


def test_role_probability_prices_dnp_and_depth_chart_uncertainty():
    assert role_play_probability("WR", 1, 8, 8) > 0.95
    assert role_play_probability("WR", 5, 8, 8) <= 0.55
    assert role_play_probability("RB", 3, 4, 8) < role_play_probability("RB", 1, 8, 8)


def test_game_environment_uses_vegas_and_weather_conservatively():
    shootout, _ = game_environment({"total_line": 55, "roof": "dome"})
    bad_weather, _ = game_environment({"total_line": 40, "wind": 24, "temp": 15, "roof": "outdoors"})

    assert shootout > 1
    assert bad_weather < 1
    assert 0.85 <= bad_weather <= 1.15
