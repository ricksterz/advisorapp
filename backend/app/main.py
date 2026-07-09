"""FastAPI backend serving the analytics tables built by the ETL layer.

Run with: uvicorn backend.app.main:app --reload
"""

import duckdb
from fastapi import FastAPI, HTTPException, Query

from etl.config import DB_PATH

app = FastAPI(title="Advisor Comp & Structure Analytics")


def query(sql: str, params: list) -> list[dict]:
    if not DB_PATH.exists():
        raise HTTPException(503, "database not built yet — run `python -m etl.ingest_adv` first")
    con = duckdb.connect(str(DB_PATH), read_only=True)
    try:
        result = con.execute(sql, params)
        cols = [d[0] for d in result.description]
        return [dict(zip(cols, row)) for row in result.fetchall()]
    finally:
        con.close()


@app.get("/api/firms")
def list_firms(
    min_aum: float | None = Query(None, description="minimum total AUM in USD"),
    fee_performance_based: bool | None = None,
    limit: int = Query(50, le=500),
):
    sql = "SELECT * FROM firms WHERE 1=1"
    params: list = []
    if min_aum is not None:
        sql += " AND aum_total >= ?"
        params.append(min_aum)
    if fee_performance_based is not None:
        sql += " AND fee_performance_based = ?"
        params.append(fee_performance_based)
    sql += " ORDER BY aum_total DESC NULLS LAST LIMIT ?"
    params.append(limit)
    return query(sql, params)


@app.get("/api/firms/{crd}")
def get_firm(crd: int):
    rows = query("SELECT * FROM firms WHERE crd = ?", [crd])
    if not rows:
        raise HTTPException(404, f"no firm with CRD {crd}")
    return rows[0]
