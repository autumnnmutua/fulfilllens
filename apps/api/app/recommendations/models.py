from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

RECOMMENDATION_VERSION = "recommendations-v1.0.0"
RecommendationPriority = Literal["high", "medium", "watch"]


class RecommendationEvidence(BaseModel):
    label: str
    value: str


class RecommendationFact(BaseModel):
    fact_id: str
    topic: str
    priority: RecommendationPriority
    priority_score: int = Field(ge=0, le=100)
    title: str
    factual_observation: str
    evidence: list[RecommendationEvidence]
    affected_order_count: int | None = Field(default=None, ge=0)
    coverage: float | None = Field(default=None, ge=0, le=1)
    confidence_warning: list[str] = Field(default_factory=list)
    recommended_action: list[str]
    suggested_kpis: list[str]
    suggested_target: str
    risk: str
    next_validation: str


class ProfessionalActionPlanItem(BaseModel):
    fact_id: str
    priority: RecommendationPriority
    problem_diagnosis: str
    data_evidence: list[str]
    root_cause_judgement: str
    improvement_actions: list[str]
    impact_scope: str
    suggested_kpis: list[str]
    suggested_target: str
    risk: str
    next_validation: str


class ExecutivePriorityItem(BaseModel):
    fact_id: str
    priority: RecommendationPriority
    what_happened: str
    impact: str
    action: str
    monitor: str


class ExecutiveBrief(BaseModel):
    overall_conclusion: str
    major_findings: list[str]
    top_priorities: list[ExecutivePriorityItem]
    expected_direction: str
    monitor_metrics: list[str]


class RecommendationBundle(BaseModel):
    facts: list[RecommendationFact]
    professional_action_plan: list[ProfessionalActionPlanItem]
    executive_brief: ExecutiveBrief
    definition_version: str = RECOMMENDATION_VERSION
    ai_used: bool = False
    presentation_source: str = "deterministic_template"
    privacy_note: str = "仅使用聚合指标、诊断结果与匿名化证据生成；不需要原始 CSV 或个人信息。"
