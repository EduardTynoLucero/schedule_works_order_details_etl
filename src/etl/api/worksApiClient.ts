import { http } from "../common/http.js";
import { WorkItem } from "../../types/worksApi.js";

export async function fetchWorkDetail(id: number) {
  const { data } = await http.get<any>(`/works/${id}`);
  return (data?.item ?? data ?? null) as WorkItem | null;
}
