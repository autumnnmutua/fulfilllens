from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes.cases import router as cases_router
from app.api.routes.dashboard import router as dashboard_router
from app.api.routes.datasets import router as datasets_router
from app.api.routes.diagnostics import router as diagnostics_router
from app.api.routes.imports import router as imports_router
from app.api.routes.integrations import router as integrations_router
from app.api.routes.metrics import router as metrics_router
from app.api.routes.reports import router as reports_router
from app.api.routes.simulations import router as simulations_router
from app.api.routes.system import router as system_router
from app.core.config import get_settings
from app.core.errors import register_error_handlers
from app.core.security import add_security_headers
from app.schemas.system import ErrorResponse


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title=settings.app_name,
        version=settings.app_version,
        description="FulfillLens CN 本地优先履约分析 API",
        responses={
            404: {
                "model": ErrorResponse,
                "description": "请求资源不存在",
            },
            422: {
                "model": ErrorResponse,
                "description": "请求参数不符合契约",
            },
            500: {
                "model": ErrorResponse,
                "description": "本地服务内部错误",
            },
        },
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=[
            "Accept",
            "Content-Type",
            "X-Request-ID",
            "X-FulfillLens-External-Call",
        ],
        expose_headers=["X-Request-ID"],
    )
    app.middleware("http")(add_security_headers)
    register_error_handlers(app)
    app.include_router(system_router)
    app.include_router(cases_router)
    app.include_router(imports_router)
    app.include_router(datasets_router)
    app.include_router(metrics_router)
    app.include_router(dashboard_router)
    app.include_router(diagnostics_router)
    app.include_router(simulations_router)
    app.include_router(reports_router)
    app.include_router(integrations_router)
    return app


app = create_app()
