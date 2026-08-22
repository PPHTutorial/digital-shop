import { supabase } from './client.js';
document.querySelector('#support-form').addEventListener('submit',async e=>{e.preventDefault();const p=Object.fromEntries(new FormData(e.currentTarget).entries());const {error}=await supabase.from('tickets').insert(p);alert(error?'Unable to create ticket.':'Ticket submitted. We’ll get back to you by email.');if(!error)e.currentTarget.reset();});
