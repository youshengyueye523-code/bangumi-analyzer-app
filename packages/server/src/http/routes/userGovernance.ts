import { ApiError } from '@bangumi-analyzer/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { executeManualFranchise, manualFranchiseCommand, previewManualFranchise, visibleManualAssignments } from '../../db/manualFranchise.js';
import { hideWork, hiddenWorks, restoreWork } from '../../db/userHides.js';
import { requirePrivateIntent } from '../privateIntent.js';

const body=z.object({command:manualFranchiseCommand,token:z.string().regex(/^[a-f0-9]{64}$/i)});
function invalid(): never {throw new ApiError('参数不合法。',{code:'invalid_user_governance',status:400,dataIntact:true});}

export function registerUserGovernance(app:FastifyInstance) {
  app.post('/api/manual-franchises/preview',async request=>{
    const parsed=manualFranchiseCommand.safeParse(request.body);
    if(!parsed.success)invalid();
    return previewManualFranchise(parsed.data);
  });
  app.post('/api/manual-franchises',async request=>{
    const parsed=body.safeParse(request.body);
    if(!parsed.success)invalid();
    return executeManualFranchise(parsed.data.command,parsed.data.token);
  });
  app.get('/api/manual-franchises/:key',async request=>visibleManualAssignments((request.params as {key:string}).key));
  app.put('/api/subjects/:id/user-hide',async request=>{
    const id=Number((request.params as {id:string}).id);
    if(!Number.isSafeInteger(id)||id<=0)invalid();
    return hideWork(id);
  });
  app.get('/api/settings/user-hidden-subjects',async request=>{
    requirePrivateIntent(request,'hidden-works');
    return {items:hiddenWorks()};
  });
  app.delete('/api/settings/user-hidden-subjects/:handle',async request=>{
    requirePrivateIntent(request,'hidden-works');
    const handle=(request.params as {handle:string}).handle;
    if(!z.string().uuid().safeParse(handle).success)invalid();
    return restoreWork(handle);
  });
}
