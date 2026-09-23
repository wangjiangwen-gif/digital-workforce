import unittest
from workflow import normalize_heat, merge_annotations

class WorkflowTests(unittest.TestCase):
    def rows(self):
        return [dict(row_id=str(i), platform='微博', heat_value=i, heat_unit='热度') for i in range(20)]
    def test_normalize_by_platform_and_keep_missing(self):
        rows=self.rows()+[dict(row_id='other',platform='知乎',heat_value=999,heat_unit='热度'),dict(row_id='missing',platform='微博',heat_value=None)]
        result=normalize_heat(rows)
        self.assertEqual(result[-1]['heat_score'],None)
        self.assertEqual(result[0]['heat_score'],0)
        self.assertEqual(result[19]['heat_score'],100)
        self.assertEqual(result[-2]['heat_score'],None)
    def test_mixed_units_rejected(self):
        rows=self.rows(); rows[0]['heat_unit']='播放'
        with self.assertRaises(ValueError): normalize_heat(rows)
    def labels(self,rows):
        return {'C0':[dict(row_id=r['row_id'],marketing_usable=True,entities=[],drivers=['词'],industries=['行业'],trigger='讨论') for r in rows],
                'C3':[dict(row_id=r['row_id'],nodes=[],holiday_marketing=False,brands=[],custom_marketing=False) for r in rows]}
    def test_missing_task_blocks(self):
        result=merge_annotations(self.rows(),{},'phase1')
        self.assertEqual(result['health']['status'],'blocked')
        self.assertEqual(result['health']['missing_tasks'],['C0','C3'])
    def test_threshold_and_nonmarketing_subset(self):
        rows=self.rows(); a=self.labels(rows); a['C0'][0]['marketing_usable']=False
        self.assertEqual(len(merge_annotations(rows,a,'phase1')['usable']),19)
        a['C0']=a['C0'][1:]
        self.assertEqual(merge_annotations(rows,a,'phase1')['health']['status'],'ready_for_review')
        a['C0']=a['C0'][1:]
        self.assertEqual(merge_annotations(rows,a,'phase1')['health']['status'],'blocked')
    def test_duplicate_and_unknown_ids_rejected(self):
        rows=self.rows(); a=self.labels(rows); a['C0'].append(a['C0'][0])
        with self.assertRaises(ValueError): merge_annotations(rows,a,'phase1')
    def test_phase2_requires_all_six_routes(self):
        rows=self.rows(); rows[0]['marketing_usable']=False
        for r in rows[1:]:r['marketing_usable']=True
        result=merge_annotations(rows,{},'phase2')
        self.assertEqual(len(result['health']['missing_tasks']),6)
        self.assertEqual(len(result['rows']),20)
if __name__=='__main__':unittest.main()
