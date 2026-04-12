"""Route looper -- infinitely loop through a closed route."""

from __future__ import annotations

import logging

from models.schemas import Coordinate, MovementMode, SimulationState
from config import resolve_speed_profile

logger = logging.getLogger(__name__)


class RouteLooper:
    """Creates a closed route through waypoints and loops it indefinitely."""

    def __init__(self, engine):
        self.engine = engine

    async def start_loop(
        self,
        waypoints: list[Coordinate],
        mode: MovementMode,
        *,
        speed_kmh: float | None = None,
        speed_min_kmh: float | None = None,
        speed_max_kmh: float | None = None,
    ) -> None:
        """Build a multi-waypoint route that forms a closed loop, then
        traverse it repeatedly until stopped.

        Parameters
        ----------
        waypoints
            Ordered waypoints forming the loop. The route will be closed
            by appending the first waypoint at the end.
        mode
            Movement mode determining speed profile.
        """
        engine = self.engine

        if len(waypoints) < 2:
            raise ValueError("At least 2 waypoints are required for a loop")

        profile_name = mode.value
        osrm_profile = "foot" if mode in (MovementMode.WALKING, MovementMode.RUNNING) else "car"

        # Close the loop: append the first waypoint at the end
        closed_waypoints = list(waypoints) + [waypoints[0]]

        # Build OSRM route through all waypoints
        wp_tuples = [(wp.lat, wp.lng) for wp in closed_waypoints]
        route_data = await engine.route_service.get_multi_route(
            wp_tuples, profile=osrm_profile,
        )

        coords = [Coordinate(lat=pt[0], lng=pt[1]) for pt in route_data["coords"]]

        if len(coords) < 2:
            raise ValueError("OSRM returned an empty route for the loop")

        engine.state = SimulationState.LOOPING
        engine.lap_count = 0
        engine.total_segments = len(coords) - 1
        engine.segment_index = 0

        await engine._emit("route_path", {
            "coords": [{"lat": c.lat, "lng": c.lng} for c in coords],
        })
        await engine._emit("state_change", {
            "state": engine.state.value,
            "waypoints": [{"lat": wp.lat, "lng": wp.lng} for wp in waypoints],
        })

        logger.info("Starting route loop with %d waypoints [%s]", len(waypoints), profile_name)

        # Loop until stopped
        while not engine._stop_event.is_set():
            engine.distance_traveled = 0.0
            engine.distance_remaining = route_data["distance"]
            engine.segment_index = 0

            # Re-pick speed each lap when a range is set, for realism.
            speed_profile = resolve_speed_profile(
                profile_name, speed_kmh, speed_min_kmh, speed_max_kmh,
            )
            await engine._move_along_route(coords, speed_profile)

            # Check if we were stopped during the route
            if engine._stop_event.is_set():
                break

            engine.lap_count += 1
            await engine._emit("lap_complete", {"lap": engine.lap_count})
            logger.info("Loop lap %d complete", engine.lap_count)

        if engine.state == SimulationState.LOOPING:
            engine.state = SimulationState.IDLE
            await engine._emit("state_change", {"state": engine.state.value})

        logger.info("Route loop stopped after %d laps", engine.lap_count)
