from fastapi import APIRouter, HTTPException

from models.schemas import (
    TeleportRequest,
    NavigateRequest,
    LoopRequest,
    MultiStopRequest,
    RandomWalkRequest,
    JoystickStartRequest,
    SimulationStatus,
    Coordinate,
    CooldownSettings,
    CooldownStatus,
    CoordFormatRequest,
    CoordinateFormat,
)

router = APIRouter(prefix="/api/location", tags=["location"])


def _engine():
    from main import app_state
    if app_state.simulation_engine is None:
        raise HTTPException(status_code=400, detail="No device connected. Connect a device first.")
    return app_state.simulation_engine


def _cooldown():
    from main import app_state
    return app_state.cooldown_timer


def _coord_fmt():
    from main import app_state
    return app_state.coord_formatter


# ── Simulation modes ─────────────────────────────────────

@router.post("/teleport")
async def teleport(req: TeleportRequest):
    engine = _engine()
    cooldown = _cooldown()

    old_pos = engine.current_position
    try:
        await engine.teleport(req.lat, req.lng)
    except Exception as e:
        import traceback, logging
        logging.getLogger("locwarp").error("Teleport failed:\n%s", traceback.format_exc())
        raise HTTPException(status_code=500, detail=str(e))

    # Start cooldown if enabled and there was a previous position
    if old_pos and cooldown.enabled:
        await cooldown.start(old_pos.lat, old_pos.lng, req.lat, req.lng)

    return {"status": "ok", "lat": req.lat, "lng": req.lng}


@router.post("/navigate")
async def navigate(req: NavigateRequest):
    import asyncio
    engine = _engine()
    asyncio.create_task(engine.navigate(
        Coordinate(lat=req.lat, lng=req.lng), req.mode,
        speed_kmh=req.speed_kmh,
        speed_min_kmh=req.speed_min_kmh, speed_max_kmh=req.speed_max_kmh,
    ))
    return {"status": "started", "destination": {"lat": req.lat, "lng": req.lng}, "mode": req.mode}


@router.post("/loop")
async def loop(req: LoopRequest):
    import asyncio
    engine = _engine()
    asyncio.create_task(engine.start_loop(
        req.waypoints, req.mode,
        speed_kmh=req.speed_kmh,
        speed_min_kmh=req.speed_min_kmh, speed_max_kmh=req.speed_max_kmh,
    ))
    return {"status": "started", "waypoints": len(req.waypoints), "mode": req.mode}


@router.post("/multistop")
async def multi_stop(req: MultiStopRequest):
    import asyncio
    engine = _engine()
    asyncio.create_task(engine.multi_stop(
        req.waypoints, req.mode, req.stop_duration, req.loop,
        speed_kmh=req.speed_kmh,
        speed_min_kmh=req.speed_min_kmh, speed_max_kmh=req.speed_max_kmh,
    ))
    return {"status": "started", "stops": len(req.waypoints), "mode": req.mode}


@router.post("/randomwalk")
async def random_walk(req: RandomWalkRequest):
    import asyncio
    engine = _engine()
    asyncio.create_task(engine.random_walk(
        req.center, req.radius_m, req.mode, req.min_pause, req.max_pause,
        speed_kmh=req.speed_kmh,
        speed_min_kmh=req.speed_min_kmh, speed_max_kmh=req.speed_max_kmh,
    ))
    return {"status": "started", "radius_m": req.radius_m, "mode": req.mode}


@router.post("/joystick/start")
async def joystick_start(req: JoystickStartRequest):
    engine = _engine()
    try:
        await engine.joystick_start(req.mode)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"status": "started", "mode": req.mode}


@router.post("/joystick/stop")
async def joystick_stop():
    engine = _engine()
    await engine.joystick_stop()
    return {"status": "stopped"}


@router.post("/pause")
async def pause():
    engine = _engine()
    await engine.pause()
    return {"status": "paused"}


@router.post("/resume")
async def resume():
    engine = _engine()
    await engine.resume()
    return {"status": "resumed"}


@router.post("/restore")
async def restore():
    engine = _engine()
    await engine.restore()
    return {"status": "restored"}


@router.delete("/simulation")
async def stop_simulation():
    engine = _engine()
    await engine.restore()
    return {"status": "stopped"}


@router.get("/debug")
async def debug_info():
    """Debug endpoint to check engine and location service state."""
    from main import app_state
    engine = app_state.simulation_engine
    if engine is None:
        return {"engine": None}
    loc_svc = engine.location_service
    return {
        "engine": type(engine).__name__,
        "state": engine.state.value if engine.state else None,
        "current_position": {"lat": engine.current_position.lat, "lng": engine.current_position.lng} if engine.current_position else None,
        "location_service": type(loc_svc).__name__ if loc_svc else None,
        "location_service_active": getattr(loc_svc, '_active', None),
    }


@router.get("/status", response_model=SimulationStatus)
async def get_status():
    engine = _engine()
    status = engine.get_status()
    cooldown = _cooldown()
    cs = cooldown.get_status()
    status.cooldown_remaining = cs["remaining_seconds"]
    return status


# ── Cooldown ──────────────────────────────────────────────

@router.get("/cooldown/status", response_model=CooldownStatus, tags=["cooldown"])
async def cooldown_status():
    cd = _cooldown()
    s = cd.get_status()
    return CooldownStatus(**s)


@router.put("/cooldown/settings", tags=["cooldown"])
async def cooldown_settings(req: CooldownSettings):
    cd = _cooldown()
    cd.enabled = req.enabled
    if not req.enabled:
        await cd.dismiss()
    return {"enabled": cd.enabled}


@router.post("/cooldown/dismiss", tags=["cooldown"])
async def cooldown_dismiss():
    cd = _cooldown()
    await cd.dismiss()
    return {"status": "dismissed"}


# ── Coordinate format ────────────────────────────────────

@router.get("/settings/coord-format", tags=["settings"])
async def get_coord_format():
    fmt = _coord_fmt()
    return {"format": fmt.format.value}


@router.put("/settings/coord-format", tags=["settings"])
async def set_coord_format(req: CoordFormatRequest):
    fmt = _coord_fmt()
    fmt.format = req.format
    return {"format": fmt.format.value}
