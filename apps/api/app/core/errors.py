from collections.abc import Awaitable, Callable
from re import fullmatch
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import Response

from app.schemas.system import ErrorBody, ErrorDetail, ErrorResponse

REQUEST_ID_PATTERN = r"[A-Za-z0-9._-]{1,64}"


class AppError(Exception):
    def __init__(
        self,
        *,
        code: str,
        message: str,
        status_code: int,
        details: list[ErrorDetail] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.details = details or []


def get_request_id(request: Request) -> str:
    request_id = getattr(request.state, "request_id", None)
    if isinstance(request_id, str):
        return request_id
    return str(uuid4())


def error_response(
    request: Request,
    *,
    status_code: int,
    code: str,
    message: str,
    details: list[ErrorDetail] | None = None,
) -> JSONResponse:
    payload = ErrorResponse(
        error=ErrorBody(
            code=code,
            message=message,
            request_id=get_request_id(request),
            details=details or [],
        )
    )
    return JSONResponse(
        status_code=status_code,
        content=payload.model_dump(mode="json"),
    )


def register_error_handlers(app: FastAPI) -> None:
    @app.middleware("http")
    async def request_id_middleware(
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        supplied_id = request.headers.get("X-Request-ID", "")
        request.state.request_id = (
            supplied_id if fullmatch(REQUEST_ID_PATTERN, supplied_id) else str(uuid4())
        )
        response = await call_next(request)
        response.headers["X-Request-ID"] = request.state.request_id
        return response

    @app.exception_handler(AppError)
    async def handle_app_error(
        request: Request,
        exception: Exception,
    ) -> JSONResponse:
        assert isinstance(exception, AppError)
        return error_response(
            request,
            status_code=exception.status_code,
            code=exception.code,
            message=exception.message,
            details=exception.details,
        )

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(
        request: Request,
        exception: Exception,
    ) -> JSONResponse:
        assert isinstance(exception, RequestValidationError)
        details = [
            ErrorDetail(
                field=".".join(str(part) for part in error["loc"]),
                message=str(error["msg"]),
                type=str(error["type"]),
            )
            for error in exception.errors()
        ]
        return error_response(
            request,
            status_code=422,
            code="VALIDATION_ERROR",
            message="请求参数不符合接口契约。",
            details=details,
        )

    @app.exception_handler(StarletteHTTPException)
    async def handle_http_error(
        request: Request,
        exception: Exception,
    ) -> JSONResponse:
        assert isinstance(exception, StarletteHTTPException)
        if exception.status_code == 404:
            code = "NOT_FOUND"
            message = "请求的资源不存在。"
        else:
            code = "HTTP_ERROR"
            message = exception.detail if isinstance(exception.detail, str) else "请求处理失败。"

        return error_response(
            request,
            status_code=exception.status_code,
            code=code,
            message=message,
        )

    @app.exception_handler(Exception)
    async def handle_unexpected_error(
        request: Request,
        exception: Exception,
    ) -> JSONResponse:
        del exception
        return error_response(
            request,
            status_code=500,
            code="INTERNAL_ERROR",
            message="本地服务发生内部错误，请使用请求标识排查。",
        )
