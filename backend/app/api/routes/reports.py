from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import FileResponse
from app.services.report_service import get_report_path
from app.services.automation_service import AutomationService
from app.api.dependencies import check_usage_limit
import os
from app.utils.response import api_response

router = APIRouter()

@router.get("/{task_id}/download")
async def download_report(task_id: str, _: None = Depends(check_usage_limit)):
    """下载分析报告"""
    report_path = get_report_path(task_id)
    
    if not os.path.exists(report_path):
        raise HTTPException(status_code=404, detail="报告文件不存在")
    
    return FileResponse(
        report_path,
        media_type="application/pdf",
        filename=f"time_series_analysis_{task_id}.pdf",
        headers={
            "Content-Disposition": f'attachment; filename="time_series_analysis_{task_id}.pdf"'
        }
    )


@router.get("/published/{slug}")
async def get_published_report(slug: str):
    payload = AutomationService.load_published_report(slug)
    if not payload:
        return api_response(success=False, error="发布内容不存在")
    return api_response(data=payload)


@router.get("/collections/{collection_slug}")
async def list_collection_reports(collection_slug: str):
    items = AutomationService.list_collection_entries(collection_slug)
    return api_response(data={
        "collection_slug": collection_slug,
        "items": items,
    })


@router.get("/collections/{collection_slug}/{entry_slug}")
async def get_collection_report(collection_slug: str, entry_slug: str):
    payload = AutomationService.load_collection_entry(collection_slug, entry_slug)
    if not payload:
        return api_response(success=False, error="发布内容不存在")
    return api_response(data=payload)
