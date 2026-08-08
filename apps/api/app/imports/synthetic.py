from __future__ import annotations

import csv
import io

from app.schemas.imports import DataType

SYNTHETIC_HEADERS: dict[DataType, list[str]] = {
    DataType.ORDERS: [
        "订单编号",
        "下单时间",
        "承诺送达时间",
        "实际送达时间",
        "订购数量",
        "已交付数量",
        "数量单位",
        "订单状态",
        "仓库编码",
        "承运商编码",
        "目的地区",
        "销售渠道",
    ],
    DataType.WAREHOUSE_EVENTS: [
        "仓库事件编号",
        "订单编号",
        "事件时间",
        "仓库状态",
        "仓库编码",
        "事件数量",
        "数量单位",
        "来源系统",
    ],
    DataType.TRACKING_EVENTS: [
        "轨迹事件编号",
        "订单编号",
        "运单编号",
        "轨迹时间",
        "物流状态",
        "承运商编码",
        "节点代码",
        "区域代码",
        "事件序号",
    ],
}

SYNTHETIC_ROWS: dict[DataType, list[list[object]]] = {
    DataType.ORDERS: [
        [
            "ORD-SYN-P3-001",
            "2026-07-01T08:00:00+08:00",
            "2026-07-03T18:00:00+08:00",
            "2026-07-03T12:00:00+08:00",
            2,
            2,
            "piece",
            "已签收",
            "WH-SYN-01",
            "CAR-SYN-01",
            "CN-SD-QD",
            "synthetic_classroom",
        ],
        [
            "ORD-SYN-P3-002",
            "2026-07-01T09:00:00+08:00",
            "2026-07-04T18:00:00+08:00",
            "2026-07-04T10:00:00+08:00",
            1,
            1,
            "piece",
            "已完成",
            "WH-SYN-01",
            "CAR-SYN-02",
            "CN-JS-NJ",
            "synthetic_classroom",
        ],
        [
            "ORD-SYN-P3-003",
            "2026-07-02T10:00:00+08:00",
            "2026-07-05T18:00:00+08:00",
            "2026-07-05T16:00:00+08:00",
            3,
            3,
            "piece",
            "已签收",
            "WH-SYN-02",
            "CAR-SYN-01",
            "CN-ZJ-HZ",
            "synthetic_classroom",
        ],
    ],
    DataType.WAREHOUSE_EVENTS: [
        [
            "WHE-SYN-P3-001",
            "ORD-SYN-P3-001",
            "2026-07-01T08:30:00+08:00",
            "仓库接单",
            "WH-SYN-01",
            2,
            "piece",
            "synthetic_generator",
        ],
        [
            "WHE-SYN-P3-002",
            "ORD-SYN-P3-001",
            "2026-07-01T09:00:00+08:00",
            "开始拣货",
            "WH-SYN-01",
            2,
            "piece",
            "synthetic_generator",
        ],
        [
            "WHE-SYN-P3-003",
            "ORD-SYN-P3-001",
            "2026-07-01T10:00:00+08:00",
            "拣货完成",
            "WH-SYN-01",
            2,
            "piece",
            "synthetic_generator",
        ],
    ],
    DataType.TRACKING_EVENTS: [
        [
            "TRE-SYN-P3-001",
            "ORD-SYN-P3-001",
            "SHP-SYN-P3-001",
            "2026-07-02T08:00:00+08:00",
            "快件已揽收",
            "CAR-SYN-01",
            "HUB-SYN-QD-01",
            "CN-SD-QD",
            1,
        ],
        [
            "TRE-SYN-P3-002",
            "ORD-SYN-P3-001",
            "SHP-SYN-P3-001",
            "2026-07-02T12:00:00+08:00",
            "运输中",
            "CAR-SYN-01",
            "HUB-SYN-QD-01",
            "CN-SD-QD",
            2,
        ],
        [
            "TRE-SYN-P3-003",
            "ORD-SYN-P3-001",
            "SHP-SYN-P3-001",
            "2026-07-03T12:00:00+08:00",
            "已签收",
            "CAR-SYN-01",
            "SITE-SYN-QD-01",
            "CN-SD-QD",
            3,
        ],
    ],
}


def build_synthetic_csv(data_type: DataType) -> bytes:
    output = io.StringIO(newline="")
    writer = csv.writer(output, lineterminator="\n")
    writer.writerow(SYNTHETIC_HEADERS[data_type])
    writer.writerows(SYNTHETIC_ROWS[data_type])
    return output.getvalue().encode("utf-8")
