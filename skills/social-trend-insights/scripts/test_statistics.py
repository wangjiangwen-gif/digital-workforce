from datetime import date
import unittest
from statistics import driving_words, summarize

class StatisticsTests(unittest.TestCase):
    def rows(self):
        return [dict(row_id=str(i),platform='微博',title='话题'+str(i),source_url='https://example.com/'+str(i),
                     marketing_usable=True,industries=['美妆'],drivers=['护肤','换季'],heat_score=50+i,event_id='e1',event_name='事件',nodes=['节点']) for i in range(3)]
    def test_equal_words_score_100(self):
        self.assertEqual([x['index'] for x in driving_words(self.rows())],[100,100])
    def test_singletons_not_events_and_calendar_is_source(self):
        r=self.rows()[:1];s=summarize(r,[dict(name='未来节点',date='2026-09-24',type='节日',opportunity='待业务判断')],date(2026,9,23))
        self.assertEqual(s['E3']['微博']['top_events'],[])
        self.assertEqual(s['E3']['微博']['top_words'],[])
        self.assertEqual(s['E2']['upcoming'][0]['name'],'未来节点')
        self.assertTrue(s['E2']['past'][0]['date_unverified'])
    def test_past_future_and_tail(self):
        rows=self.rows();rows[0]['nodes']=['旧'];rows[1]['nodes']=['今'];rows[2]['nodes']=['前']
        s=summarize(rows,[dict(name='旧',date='2026-09-01'),dict(name='今',date='2026-09-23'),dict(name='前',date='2026-09-22')],date(2026,9,23))
        self.assertEqual([x['node'] for x in s['E2']['past']],['前']);self.assertEqual(s['E2']['supplement'],['今'])
    def test_platform_isolation(self):
        rows=self.rows();other=[dict(r,row_id='other'+r['row_id'],platform='知乎',heat_score=100) for r in rows]
        a=summarize(rows,[],date(2026,9,23));b=summarize(rows+other,[],date(2026,9,23))
        self.assertEqual(a['E3']['微博'],b['E3']['微博'])
if __name__=='__main__':unittest.main()
