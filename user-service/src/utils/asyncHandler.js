
// utils/asyncHandler.js
module.exports = fn => (req, res, next) => {
     Promise.resolve(fn(req, res, next)).catch(next);
};

 function asyncErrorHandler(func)
{
  return async function(req,res,next){
     try{
       await func(req,res);
     }
     catch(err)
     {
          next(err);
     }
  }
}

module.exports=asyncErrorHandler